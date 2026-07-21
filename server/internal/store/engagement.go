package store

import (
	"context"
	"fmt"
	"math"
	"time"
)

type BookDetail struct {
	Book               BookFile     `json:"book"`
	Description        string       `json:"description"`
	ReadingState       ReadingState `json:"readingState"`
	Favorite           bool         `json:"favorite"`
	FavoritedAt        *time.Time   `json:"favoritedAt,omitempty"`
	ReaderCount        int          `json:"readerCount"`
	FavoriteCount      int          `json:"favoriteCount"`
	TotalActiveSeconds int64        `json:"totalActiveSeconds"`
}

type FavoriteState struct {
	BookFileID int64      `json:"bookFileId"`
	Favorite   bool       `json:"favorite"`
	CreatedAt  *time.Time `json:"createdAt,omitempty"`
}

type FavoriteBook struct {
	Book        BookFile  `json:"book"`
	FavoritedAt time.Time `json:"favoritedAt"`
}

type FavoritePage struct {
	Items      []FavoriteBook `json:"items"`
	Total      int            `json:"total"`
	Page       int            `json:"page"`
	PageSize   int            `json:"pageSize"`
	TotalPages int            `json:"totalPages"`
}

type Recommendation struct {
	Book         BookFile `json:"book"`
	Reason       string   `json:"reason"`
	Score        float64  `json:"score"`
	Personalized bool     `json:"personalized"`
}

type RecommendationPage struct {
	Items        []Recommendation `json:"items"`
	Personalized bool             `json:"personalized"`
}

type tasteProfile struct {
	CategoryIDs    []int64
	CategoryScores []float64
	CategoryNames  []string
	CreatorIDs     []int64
	CreatorScores  []float64
	CreatorNames   []string
}

type recommendationMetric struct {
	BookFileID  int64
	Category    string
	CategoryFit float64
	Creator     string
	CreatorFit  float64
	HeatScore   float64
	Score       float64
}

func (s *Store) GetBookDetail(ctx context.Context, userID, bookFileID int64) (BookDetail, bool, error) {
	book, found, err := s.GetCatalogBook(ctx, bookFileID)
	if err != nil || !found {
		return BookDetail{}, found, err
	}
	readingState, err := s.GetReadingState(ctx, userID, bookFileID)
	if err != nil {
		return BookDetail{}, false, fmt.Errorf("load book reading state: %w", err)
	}
	detail := BookDetail{Book: book, ReadingState: readingState}
	err = s.pool.QueryRow(ctx, `
		SELECT COALESCE(w.description,''),uf.created_at,
			(SELECT COUNT(DISTINCT rs.user_id) FROM reading_sessions rs WHERE rs.book_file_id=bf.id AND rs.active_seconds>0)::int,
			(SELECT COUNT(*) FROM user_favorites all_uf WHERE all_uf.book_file_id=bf.id)::int,
			COALESCE((SELECT SUM(rs.active_seconds) FROM reading_sessions rs WHERE rs.book_file_id=bf.id),0)::bigint
		FROM book_files bf
		JOIN editions e ON e.id=bf.edition_id
		JOIN works w ON w.id=e.work_id
		LEFT JOIN user_favorites uf ON uf.book_file_id=bf.id AND uf.user_id=$1
		WHERE bf.id=$2`, userID, bookFileID,
	).Scan(&detail.Description, &detail.FavoritedAt, &detail.ReaderCount, &detail.FavoriteCount, &detail.TotalActiveSeconds)
	if err != nil {
		return BookDetail{}, false, fmt.Errorf("load book detail: %w", err)
	}
	detail.Favorite = detail.FavoritedAt != nil
	return detail, true, nil
}

func (s *Store) SetFavorite(ctx context.Context, userID, bookFileID int64, favorite bool) (FavoriteState, error) {
	if !favorite {
		_, err := s.pool.Exec(ctx, "DELETE FROM user_favorites WHERE user_id=$1 AND book_file_id=$2", userID, bookFileID)
		return FavoriteState{BookFileID: bookFileID}, err
	}
	var createdAt time.Time
	err := s.pool.QueryRow(ctx, `
		INSERT INTO user_favorites(user_id,book_file_id) VALUES ($1,$2)
		ON CONFLICT (user_id,book_file_id) DO UPDATE SET user_id=EXCLUDED.user_id
		RETURNING created_at`, userID, bookFileID,
	).Scan(&createdAt)
	if err != nil {
		return FavoriteState{}, fmt.Errorf("save favorite: %w", err)
	}
	return FavoriteState{BookFileID: bookFileID, Favorite: true, CreatedAt: &createdAt}, nil
}

func (s *Store) ListFavoriteBooks(ctx context.Context, userID int64, page, pageSize int) (FavoritePage, error) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > MaxCatalogPageSize {
		pageSize = DefaultCatalogPageSize
	}
	var total int
	if err := s.pool.QueryRow(ctx, `SELECT COUNT(*) FROM user_favorites uf
		JOIN users u ON u.id=uf.user_id AND u.disabled_at IS NULL
		LEFT JOIN book_file_permissions p ON p.user_id=u.id AND p.book_file_id=uf.book_file_id
		WHERE uf.user_id=$1 AND (u.role='admin' OR COALESCE(p.can_read,true))`, userID).Scan(&total); err != nil {
		return FavoritePage{}, fmt.Errorf("count favorites: %w", err)
	}
	rows, err := s.pool.Query(ctx, `
		SELECT uf.book_file_id,uf.created_at FROM user_favorites uf
		JOIN users u ON u.id=uf.user_id AND u.disabled_at IS NULL
		LEFT JOIN book_file_permissions p ON p.user_id=u.id AND p.book_file_id=uf.book_file_id
		WHERE uf.user_id=$1 AND (u.role='admin' OR COALESCE(p.can_read,true))
		ORDER BY uf.created_at DESC,uf.book_file_id DESC LIMIT $2 OFFSET $3`,
		userID, pageSize, (page-1)*pageSize)
	if err != nil {
		return FavoritePage{}, fmt.Errorf("list favorites: %w", err)
	}
	defer rows.Close()
	type favoriteReference struct {
		ID        int64
		CreatedAt time.Time
	}
	references := make([]favoriteReference, 0, pageSize)
	ids := make([]int64, 0, pageSize)
	for rows.Next() {
		var reference favoriteReference
		if err := rows.Scan(&reference.ID, &reference.CreatedAt); err != nil {
			return FavoritePage{}, err
		}
		references = append(references, reference)
		ids = append(ids, reference.ID)
	}
	if err := rows.Err(); err != nil {
		return FavoritePage{}, err
	}
	books, err := s.catalogBooksByID(ctx, ids)
	if err != nil {
		return FavoritePage{}, err
	}
	items := make([]FavoriteBook, 0, len(references))
	for _, reference := range references {
		if book, ok := books[reference.ID]; ok {
			items = append(items, FavoriteBook{Book: book, FavoritedAt: reference.CreatedAt})
		}
	}
	totalPages := 0
	if total > 0 {
		totalPages = (total + pageSize - 1) / pageSize
	}
	return FavoritePage{Items: items, Total: total, Page: page, PageSize: pageSize, TotalPages: totalPages}, nil
}

func (s *Store) GetRecommendations(ctx context.Context, userID int64, limit int) (RecommendationPage, error) {
	if limit < 1 || limit > 24 {
		limit = 12
	}
	profile, err := s.loadTasteProfile(ctx, userID)
	if err != nil {
		return RecommendationPage{}, err
	}
	metrics, err := s.listRecommendationMetrics(ctx, userID, profile, limit)
	if err != nil {
		return RecommendationPage{}, err
	}
	ids := make([]int64, 0, len(metrics))
	for _, metric := range metrics {
		ids = append(ids, metric.BookFileID)
	}
	allowedIDs, err := s.FilterAccessibleBookIDs(ctx, userID, ids)
	if err != nil {
		return RecommendationPage{}, err
	}
	filteredMetrics := metrics[:0]
	filteredIDs := ids[:0]
	for _, metric := range metrics {
		if allowedIDs[metric.BookFileID] {
			filteredMetrics = append(filteredMetrics, metric)
			filteredIDs = append(filteredIDs, metric.BookFileID)
		}
	}
	metrics, ids = filteredMetrics, filteredIDs
	books, err := s.catalogBooksByID(ctx, ids)
	if err != nil {
		return RecommendationPage{}, err
	}
	personalized := len(profile.CategoryIDs) > 0 || len(profile.CreatorIDs) > 0
	items := make([]Recommendation, 0, len(metrics))
	for _, metric := range metrics {
		book, ok := books[metric.BookFileID]
		if !ok {
			continue
		}
		itemPersonalized := metric.CategoryFit > 0 || metric.CreatorFit > 0
		items = append(items, Recommendation{
			Book: book, Reason: recommendationReason(metric), Score: math.Round(metric.Score*100) / 100,
			Personalized: itemPersonalized,
		})
	}
	return RecommendationPage{Items: items, Personalized: personalized}, nil
}

func (s *Store) loadTasteProfile(ctx context.Context, userID int64) (tasteProfile, error) {
	profile := tasteProfile{
		CategoryIDs: []int64{}, CategoryScores: []float64{}, CategoryNames: []string{},
		CreatorIDs: []int64{}, CreatorScores: []float64{}, CreatorNames: []string{},
	}
	const interactions = `
		WITH interactions AS (
			SELECT bf.edition_id,
				(CASE WHEN uf.user_id IS NOT NULL THEN 5.0 ELSE 0 END
				 + CASE COALESCE(rs.status,'') WHEN 'finished' THEN 3.0 WHEN 'reading' THEN 2.5 WHEN 'paused' THEN 1.5 WHEN 'unread' THEN 0.5 ELSE 0.25 END
				 + COALESCE(rs.overall_progress,0)*2.0
				 + LEAST(COALESCE(rs.total_active_seconds,0)/3600.0,3.0))::double precision AS weight
			FROM book_files bf
			LEFT JOIN user_favorites uf ON uf.book_file_id=bf.id AND uf.user_id=$1
			LEFT JOIN reading_states rs ON rs.book_file_id=bf.id AND rs.user_id=$1
			WHERE uf.user_id IS NOT NULL OR rs.user_id IS NOT NULL
		)`
	categoryRows, err := s.pool.Query(ctx, interactions+`, category_affinity AS (
			SELECT DISTINCT i.edition_id,i.weight,cat.id,cat.name
			FROM interactions i
			JOIN classification_decisions cd ON cd.edition_id=i.edition_id AND cd.status='accepted'
			JOIN categories cat ON cat.id=cd.category_id
		)
		SELECT id,name,SUM(weight)::double precision FROM category_affinity
		GROUP BY id,name ORDER BY 3 DESC,id LIMIT 12`, userID)
	if err != nil {
		return tasteProfile{}, fmt.Errorf("load category preferences: %w", err)
	}
	for categoryRows.Next() {
		var id int64
		var name string
		var score float64
		if err := categoryRows.Scan(&id, &name, &score); err != nil {
			categoryRows.Close()
			return tasteProfile{}, err
		}
		profile.CategoryIDs = append(profile.CategoryIDs, id)
		profile.CategoryScores = append(profile.CategoryScores, score)
		profile.CategoryNames = append(profile.CategoryNames, name)
	}
	if err := categoryRows.Err(); err != nil {
		categoryRows.Close()
		return tasteProfile{}, err
	}
	categoryRows.Close()

	creatorRows, err := s.pool.Query(ctx, interactions+`, creator_affinity AS (
			SELECT DISTINCT i.edition_id,i.weight,c.id,c.name
			FROM interactions i
			JOIN edition_creators ec ON ec.edition_id=i.edition_id AND ec.role='author'
			JOIN creators c ON c.id=ec.creator_id
		)
		SELECT id,name,SUM(weight)::double precision FROM creator_affinity
		GROUP BY id,name ORDER BY 3 DESC,id LIMIT 12`, userID)
	if err != nil {
		return tasteProfile{}, fmt.Errorf("load creator preferences: %w", err)
	}
	defer creatorRows.Close()
	for creatorRows.Next() {
		var id int64
		var name string
		var score float64
		if err := creatorRows.Scan(&id, &name, &score); err != nil {
			return tasteProfile{}, err
		}
		profile.CreatorIDs = append(profile.CreatorIDs, id)
		profile.CreatorScores = append(profile.CreatorScores, score)
		profile.CreatorNames = append(profile.CreatorNames, name)
	}
	return profile, creatorRows.Err()
}

func (s *Store) listRecommendationMetrics(ctx context.Context, userID int64, profile tasteProfile, limit int) ([]recommendationMetric, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT bf.id,COALESCE(category_match.name,''),COALESCE(category_match.score,0),
			COALESCE(creator_match.name,''),COALESCE(creator_match.score,0),COALESCE(hot.score,0),
			(COALESCE(category_match.score,0)*3.0 + COALESCE(creator_match.score,0)*4.0
			 + LN(1.0+COALESCE(hot.score,0))*0.4
			 + CASE WHEN bf.created_at >= now()-INTERVAL '30 days' THEN 0.5 ELSE 0 END)::double precision AS score
		FROM book_files bf
		JOIN editions e ON e.id=bf.edition_id
		JOIN users access_user ON access_user.id=$1 AND access_user.disabled_at IS NULL
		LEFT JOIN book_file_permissions permission ON permission.user_id=access_user.id AND permission.book_file_id=bf.id
		LEFT JOIN LATERAL (
			SELECT pref.name,pref.score
			FROM unnest($2::bigint[],$3::double precision[],$4::text[]) AS pref(id,score,name)
			WHERE EXISTS (SELECT 1 FROM classification_decisions cd
				WHERE cd.edition_id=e.id AND cd.status='accepted' AND cd.category_id=pref.id)
			ORDER BY pref.score DESC,pref.id LIMIT 1
		) category_match ON true
		LEFT JOIN LATERAL (
			SELECT pref.name,pref.score
			FROM unnest($5::bigint[],$6::double precision[],$7::text[]) AS pref(id,score,name)
			WHERE EXISTS (SELECT 1 FROM edition_creators ec
				WHERE ec.edition_id=e.id AND ec.role='author' AND ec.creator_id=pref.id)
			ORDER BY pref.score DESC,pref.id LIMIT 1
		) creator_match ON true
		LEFT JOIN LATERAL (
			SELECT (COALESCE(SUM(rs.active_seconds),0)+COUNT(*)*30+COUNT(DISTINCT rs.user_id)*300)::double precision AS score
			FROM reading_sessions rs WHERE rs.book_file_id=bf.id AND rs.started_at >= now()-INTERVAL '30 days'
		) hot ON true
		WHERE (access_user.role='admin' OR COALESCE(permission.can_read,true))
			AND NOT EXISTS (SELECT 1 FROM user_favorites uf WHERE uf.user_id=$1 AND uf.book_file_id=bf.id)
			AND NOT EXISTS (SELECT 1 FROM reading_states state WHERE state.user_id=$1 AND state.book_file_id=bf.id
				AND state.status IN ('reading','paused','finished','abandoned'))
		ORDER BY score DESC,bf.created_at DESC,bf.id DESC LIMIT $8`,
		userID,
		profile.CategoryIDs, profile.CategoryScores, profile.CategoryNames,
		profile.CreatorIDs, profile.CreatorScores, profile.CreatorNames,
		limit)
	if err != nil {
		return nil, fmt.Errorf("list recommendations: %w", err)
	}
	defer rows.Close()
	items := make([]recommendationMetric, 0, limit)
	for rows.Next() {
		var item recommendationMetric
		if err := rows.Scan(
			&item.BookFileID, &item.Category, &item.CategoryFit, &item.Creator, &item.CreatorFit,
			&item.HeatScore, &item.Score,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func recommendationReason(metric recommendationMetric) string {
	if metric.CreatorFit > 0 && metric.Creator != "" {
		return fmt.Sprintf("因为你读过或收藏过 %s 的作品", metric.Creator)
	}
	if metric.CategoryFit > 0 && metric.Category != "" {
		return fmt.Sprintf("根据你对%s类书籍的偏好", metric.Category)
	}
	if metric.HeatScore > 0 {
		return "书库近期热门"
	}
	return "最近加入书库"
}
