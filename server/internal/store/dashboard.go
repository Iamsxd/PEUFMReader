package store

import (
	"context"
	"fmt"
	"time"
)

type HomeBook struct {
	Book               BookFile   `json:"book"`
	OverallProgress    float64    `json:"overallProgress,omitempty"`
	Status             string     `json:"status,omitempty"`
	TotalActiveSeconds int64      `json:"totalActiveSeconds,omitempty"`
	LastReadAt         *time.Time `json:"lastReadAt,omitempty"`
	ReaderCount        int        `json:"readerCount,omitempty"`
	SessionCount       int        `json:"sessionCount,omitempty"`
	HeatScore          float64    `json:"heatScore,omitempty"`
}

type CategorySummary struct {
	ID           int64    `json:"id"`
	Slug         string   `json:"slug"`
	Name         string   `json:"name"`
	ParentID     *int64   `json:"parentId,omitempty"`
	ParentName   string   `json:"parentName,omitempty"`
	BookCount    int      `json:"bookCount"`
	CoverURLs    []string `json:"coverUrls"`
	CoverBookIDs []int64  `json:"-"`
}

type PersonalStats struct {
	TotalBooks         int   `json:"totalBooks"`
	ReadingBooks       int   `json:"readingBooks"`
	FinishedBooks      int   `json:"finishedBooks"`
	FavoriteBooks      int   `json:"favoriteBooks"`
	TotalActiveSeconds int64 `json:"totalActiveSeconds"`
	WeekActiveSeconds  int64 `json:"weekActiveSeconds"`
}

type HomeDashboard struct {
	ContinueReading []HomeBook        `json:"continueReading"`
	HotBooks        []HomeBook        `json:"hotBooks"`
	Recommendations []Recommendation  `json:"recommendations"`
	RecentlyAdded   []BookFile        `json:"recentlyAdded"`
	Categories      []CategorySummary `json:"categories"`
	Stats           PersonalStats     `json:"stats"`
}

type continueMetric struct {
	BookFileID      int64
	OverallProgress float64
	Status          string
	ActiveSeconds   int64
	UpdatedAt       time.Time
}

type hotMetric struct {
	BookFileID    int64
	ReaderCount   int
	SessionCount  int
	ActiveSeconds int64
	HeatScore     float64
}

func (s *Store) GetHomeDashboard(ctx context.Context, userID int64) (HomeDashboard, error) {
	continueMetrics, err := s.listContinueMetrics(ctx, userID, 6)
	if err != nil {
		return HomeDashboard{}, err
	}
	hotMetrics, err := s.listHotMetrics(ctx, userID, 8)
	if err != nil {
		return HomeDashboard{}, err
	}
	recentIDs, err := s.listRecentlyAddedIDs(ctx, userID, 8)
	if err != nil {
		return HomeDashboard{}, err
	}
	categories, err := s.listCategorySummaries(ctx, userID)
	if err != nil {
		return HomeDashboard{}, err
	}
	stats, err := s.getPersonalStats(ctx, userID)
	if err != nil {
		return HomeDashboard{}, err
	}
	recommendations, err := s.GetRecommendations(ctx, userID, 8)
	if err != nil {
		return HomeDashboard{}, err
	}

	bookIDs := make([]int64, 0, len(continueMetrics)+len(hotMetrics)+len(recentIDs))
	seen := make(map[int64]bool)
	appendID := func(id int64) {
		if !seen[id] {
			seen[id] = true
			bookIDs = append(bookIDs, id)
		}
	}
	for _, metric := range continueMetrics {
		appendID(metric.BookFileID)
	}
	for _, metric := range hotMetrics {
		appendID(metric.BookFileID)
	}
	for _, id := range recentIDs {
		appendID(id)
	}
	for _, category := range categories {
		for _, id := range category.CoverBookIDs {
			appendID(id)
		}
	}
	allowedIDs, err := s.FilterAccessibleBookIDs(ctx, userID, bookIDs)
	if err != nil {
		return HomeDashboard{}, err
	}
	filteredBookIDs := bookIDs[:0]
	for _, id := range bookIDs {
		if allowedIDs[id] {
			filteredBookIDs = append(filteredBookIDs, id)
		}
	}
	bookIDs = filteredBookIDs
	books, err := s.catalogBooksByID(ctx, bookIDs)
	if err != nil {
		return HomeDashboard{}, err
	}

	dashboard := HomeDashboard{
		ContinueReading: make([]HomeBook, 0, len(continueMetrics)),
		HotBooks:        make([]HomeBook, 0, len(hotMetrics)),
		Recommendations: recommendations.Items,
		RecentlyAdded:   make([]BookFile, 0, len(recentIDs)),
		Categories:      categories,
		Stats:           stats,
	}
	for index := range dashboard.Categories {
		coverIDs := dashboard.Categories[index].CoverBookIDs[:0]
		for _, id := range dashboard.Categories[index].CoverBookIDs {
			if allowedIDs[id] {
				coverIDs = append(coverIDs, id)
			}
		}
		dashboard.Categories[index].CoverBookIDs = coverIDs
	}
	for _, metric := range continueMetrics {
		book, ok := books[metric.BookFileID]
		if !ok {
			continue
		}
		lastReadAt := metric.UpdatedAt
		dashboard.ContinueReading = append(dashboard.ContinueReading, HomeBook{
			Book: book, OverallProgress: metric.OverallProgress, Status: metric.Status,
			TotalActiveSeconds: metric.ActiveSeconds, LastReadAt: &lastReadAt,
		})
	}
	for _, metric := range hotMetrics {
		book, ok := books[metric.BookFileID]
		if !ok {
			continue
		}
		dashboard.HotBooks = append(dashboard.HotBooks, HomeBook{
			Book: book, ReaderCount: metric.ReaderCount, SessionCount: metric.SessionCount,
			TotalActiveSeconds: metric.ActiveSeconds, HeatScore: metric.HeatScore,
		})
	}
	for _, id := range recentIDs {
		if book, ok := books[id]; ok {
			dashboard.RecentlyAdded = append(dashboard.RecentlyAdded, book)
		}
	}
	return dashboard, nil
}

func (s *Store) listContinueMetrics(ctx context.Context, userID int64, limit int) ([]continueMetric, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT rs.book_file_id,rs.overall_progress,rs.status,rs.total_active_seconds,rs.updated_at
		FROM reading_states rs
		WHERE rs.user_id=$1 AND rs.status IN ('reading','paused') AND rs.overall_progress < 0.999
			AND can_user_read_book($1,rs.book_file_id)
		ORDER BY rs.updated_at DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("list continue reading: %w", err)
	}
	defer rows.Close()
	items := make([]continueMetric, 0, limit)
	for rows.Next() {
		var item continueMetric
		if err := rows.Scan(&item.BookFileID, &item.OverallProgress, &item.Status, &item.ActiveSeconds, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) listHotMetrics(ctx context.Context, userID int64, limit int) ([]hotMetric, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT rs.book_file_id,COUNT(DISTINCT rs.user_id)::int,COUNT(*)::int,COALESCE(SUM(rs.active_seconds),0)::bigint,
			COALESCE(SUM(rs.active_seconds * CASE WHEN rs.started_at >= now()-INTERVAL '7 days' THEN 1.0 ELSE 0.45 END)
				+ COUNT(*) * 30 + COUNT(DISTINCT rs.user_id) * 300,0)::double precision AS heat_score
		FROM reading_sessions rs
		WHERE rs.started_at >= now()-INTERVAL '30 days' AND rs.active_seconds > 0
			AND can_user_read_book($1,rs.book_file_id)
		GROUP BY rs.book_file_id
		ORDER BY heat_score DESC,MAX(rs.started_at) DESC
		LIMIT $2`, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("list hot books: %w", err)
	}
	defer rows.Close()
	items := make([]hotMetric, 0, limit)
	for rows.Next() {
		var item hotMetric
		if err := rows.Scan(&item.BookFileID, &item.ReaderCount, &item.SessionCount, &item.ActiveSeconds, &item.HeatScore); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) listRecentlyAddedIDs(ctx context.Context, userID int64, limit int) ([]int64, error) {
	rows, err := s.pool.Query(ctx, `SELECT bf.id FROM book_files bf
		WHERE can_user_read_book($1,bf.id)
		ORDER BY bf.created_at DESC,bf.id DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("list recently added books: %w", err)
	}
	defer rows.Close()
	ids := make([]int64, 0, limit)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Store) listCategorySummaries(ctx context.Context, userID int64) ([]CategorySummary, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT cat.id,cat.slug,cat.name,cat.parent_id,COALESCE(parent.name,''),
			(SELECT COUNT(DISTINCT bf.id)
			 FROM classification_decisions cd
			 JOIN editions e ON e.id=cd.edition_id
			 JOIN book_files bf ON bf.edition_id=e.id
			 WHERE cd.category_id IN (
				WITH RECURSIVE category_tree AS (
					SELECT id FROM categories WHERE id=cat.id
					UNION ALL SELECT child.id FROM categories child JOIN category_tree tree ON child.parent_id=tree.id
				) SELECT id FROM category_tree
			 ) AND cd.status='accepted' AND can_user_read_book($1,bf.id))::int,
			COALESCE((SELECT array_agg(recent.id) FROM (
				SELECT DISTINCT bf.id,bf.created_at
				FROM classification_decisions cd
				JOIN editions e ON e.id=cd.edition_id
				JOIN book_files bf ON bf.edition_id=e.id
				WHERE cd.category_id IN (
					WITH RECURSIVE category_tree AS (
						SELECT id FROM categories WHERE id=cat.id
						UNION ALL SELECT child.id FROM categories child JOIN category_tree tree ON child.parent_id=tree.id
					) SELECT id FROM category_tree
				) AND cd.status='accepted' AND bf.cover_path IS NOT NULL
					AND can_user_read_book($1,bf.id)
				ORDER BY bf.created_at DESC LIMIT 4
			) recent),'{}'::bigint[])
		FROM categories cat LEFT JOIN categories parent ON parent.id=cat.parent_id
		WHERE cat.active=true
		ORDER BY 6 DESC,COALESCE(parent.name,cat.name),cat.parent_id NULLS FIRST,cat.name`, userID)
	if err != nil {
		return nil, fmt.Errorf("list category summaries: %w", err)
	}
	defer rows.Close()
	items := make([]CategorySummary, 0)
	for rows.Next() {
		var item CategorySummary
		if err := rows.Scan(&item.ID, &item.Slug, &item.Name, &item.ParentID, &item.ParentName, &item.BookCount, &item.CoverBookIDs); err != nil {
			return nil, err
		}
		item.CoverURLs = []string{}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) getPersonalStats(ctx context.Context, userID int64) (PersonalStats, error) {
	var stats PersonalStats
	err := s.pool.QueryRow(ctx, `
		WITH accessible_books AS (
			SELECT bf.id FROM book_files bf WHERE can_user_read_book($1,bf.id)
		)
		SELECT
			(SELECT COUNT(*) FROM accessible_books)::int,
			COUNT(*) FILTER (WHERE rs.status IN ('reading','paused'))::int,
			COUNT(*) FILTER (WHERE rs.status='finished')::int,
			(SELECT COUNT(*) FROM user_favorites uf JOIN accessible_books ab ON ab.id=uf.book_file_id WHERE uf.user_id=$1)::int,
			COALESCE(SUM(rs.total_active_seconds),0)::bigint,
			COALESCE((SELECT SUM(s.active_seconds) FROM reading_sessions s JOIN accessible_books ab ON ab.id=s.book_file_id WHERE s.user_id=$1 AND s.started_at >= now()-INTERVAL '7 days'),0)::bigint
		FROM reading_states rs JOIN accessible_books ab ON ab.id=rs.book_file_id WHERE rs.user_id=$1`, userID,
	).Scan(&stats.TotalBooks, &stats.ReadingBooks, &stats.FinishedBooks, &stats.FavoriteBooks, &stats.TotalActiveSeconds, &stats.WeekActiveSeconds)
	if err != nil {
		return PersonalStats{}, fmt.Errorf("load personal reading stats: %w", err)
	}
	return stats, nil
}

func (s *Store) catalogBooksByID(ctx context.Context, ids []int64) (map[int64]BookFile, error) {
	result := make(map[int64]BookFile, len(ids))
	if len(ids) == 0 {
		return result, nil
	}
	rows, err := s.pool.Query(ctx, catalogBookSelect+" WHERE bf.id=ANY($1)", ids)
	if err != nil {
		return nil, fmt.Errorf("load dashboard books: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		book, scanErr := scanCatalogBook(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result[book.ID] = book
	}
	return result, rows.Err()
}
