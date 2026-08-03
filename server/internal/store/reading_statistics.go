package store

import (
	"context"
	"fmt"
	"time"
)

const readingStatisticsDays = 84

type DailyReadingActivity struct {
	Date          string `json:"date"`
	ActiveSeconds int64  `json:"activeSeconds"`
}

type ReadingFormatBreakdown struct {
	Format        string `json:"format"`
	BookCount     int    `json:"bookCount"`
	ActiveSeconds int64  `json:"activeSeconds"`
}

type ReadingCategoryBreakdown struct {
	ID            int64  `json:"id"`
	Slug          string `json:"slug"`
	Name          string `json:"name"`
	BookCount     int    `json:"bookCount"`
	ActiveSeconds int64  `json:"activeSeconds"`
}

type FinishedReadingBook struct {
	Book               BookFile  `json:"book"`
	FinishedAt         time.Time `json:"finishedAt"`
	TotalActiveSeconds int64     `json:"totalActiveSeconds"`
}

type ReadingStatistics struct {
	GeneratedAt         time.Time                  `json:"generatedAt"`
	WindowDays          int                        `json:"windowDays"`
	TodayActiveSeconds  int64                      `json:"todayActiveSeconds"`
	WeekActiveSeconds   int64                      `json:"weekActiveSeconds"`
	MonthActiveSeconds  int64                      `json:"monthActiveSeconds"`
	TotalActiveSeconds  int64                      `json:"totalActiveSeconds"`
	TrackedBooks        int                        `json:"trackedBooks"`
	ReadingBooks        int                        `json:"readingBooks"`
	FinishedBooks       int                        `json:"finishedBooks"`
	CompletedLast30Days int                        `json:"completedLast30Days"`
	CurrentStreakDays   int                        `json:"currentStreakDays"`
	LongestStreakDays   int                        `json:"longestStreakDays"`
	DailyActivity       []DailyReadingActivity     `json:"dailyActivity"`
	Formats             []ReadingFormatBreakdown   `json:"formats"`
	Categories          []ReadingCategoryBreakdown `json:"categories"`
	RecentlyFinished    []FinishedReadingBook      `json:"recentlyFinished"`
}

func (s *Store) GetReadingStatistics(ctx context.Context, userID int64) (ReadingStatistics, error) {
	statistics := ReadingStatistics{
		GeneratedAt: time.Now().UTC(), WindowDays: readingStatisticsDays,
		DailyActivity: []DailyReadingActivity{}, Formats: []ReadingFormatBreakdown{},
		Categories: []ReadingCategoryBreakdown{}, RecentlyFinished: []FinishedReadingBook{},
	}
	if err := s.pool.QueryRow(ctx, `
		WITH accessible_books AS MATERIALIZED (
			SELECT book_file_id AS id FROM accessible_book_ids($1)
		)
		SELECT
			COALESCE((SELECT SUM(session.active_seconds) FROM reading_sessions session
				JOIN accessible_books book ON book.id=session.book_file_id WHERE session.user_id=$1),0)::bigint,
			COALESCE((SELECT SUM(session.active_seconds) FROM reading_sessions session
				JOIN accessible_books book ON book.id=session.book_file_id WHERE session.user_id=$1 AND session.started_at >= date_trunc('day',now())),0)::bigint,
			COALESCE((SELECT SUM(session.active_seconds) FROM reading_sessions session
				JOIN accessible_books book ON book.id=session.book_file_id WHERE session.user_id=$1 AND session.started_at >= date_trunc('day',now())-INTERVAL '6 days'),0)::bigint,
			COALESCE((SELECT SUM(session.active_seconds) FROM reading_sessions session
				JOIN accessible_books book ON book.id=session.book_file_id WHERE session.user_id=$1 AND session.started_at >= date_trunc('day',now())-INTERVAL '29 days'),0)::bigint,
			COUNT(*) FILTER (WHERE state.status <> 'unread')::int,
			COUNT(*) FILTER (WHERE state.status IN ('reading','paused'))::int,
			COUNT(*) FILTER (WHERE state.status='finished')::int,
			COUNT(*) FILTER (WHERE state.status='finished' AND state.updated_at >= now()-INTERVAL '30 days')::int
		FROM reading_states state
		JOIN accessible_books book ON book.id=state.book_file_id
		WHERE state.user_id=$1`, userID,
	).Scan(
		&statistics.TotalActiveSeconds, &statistics.TodayActiveSeconds, &statistics.WeekActiveSeconds, &statistics.MonthActiveSeconds,
		&statistics.TrackedBooks, &statistics.ReadingBooks, &statistics.FinishedBooks, &statistics.CompletedLast30Days,
	); err != nil {
		return ReadingStatistics{}, fmt.Errorf("load reading statistics summary: %w", err)
	}

	dailyRows, err := s.pool.Query(ctx, `
		SELECT to_char(session.started_at::date,'YYYY-MM-DD'),COALESCE(SUM(session.active_seconds),0)::bigint
		FROM reading_sessions session
		JOIN accessible_book_ids($1) accessible ON accessible.book_file_id=session.book_file_id
		WHERE session.user_id=$1 AND session.started_at >= date_trunc('day',now())-($2::int-1)*INTERVAL '1 day'
		GROUP BY session.started_at::date ORDER BY session.started_at::date`, userID, readingStatisticsDays)
	if err != nil {
		return ReadingStatistics{}, fmt.Errorf("load daily reading activity: %w", err)
	}
	dailyValues := make(map[string]int64, readingStatisticsDays)
	for dailyRows.Next() {
		var date string
		var activeSeconds int64
		if err := dailyRows.Scan(&date, &activeSeconds); err != nil {
			dailyRows.Close()
			return ReadingStatistics{}, err
		}
		dailyValues[date] = activeSeconds
	}
	if err := dailyRows.Err(); err != nil {
		dailyRows.Close()
		return ReadingStatistics{}, err
	}
	dailyRows.Close()
	statistics.DailyActivity = completeDailyActivity(time.Now(), readingStatisticsDays, dailyValues)
	statistics.CurrentStreakDays, statistics.LongestStreakDays = readingStreaks(statistics.DailyActivity)

	formatRows, err := s.pool.Query(ctx, `
		SELECT book.format,COUNT(DISTINCT session.book_file_id)::int,COALESCE(SUM(session.active_seconds),0)::bigint
		FROM reading_sessions session
		JOIN accessible_book_ids($1) accessible ON accessible.book_file_id=session.book_file_id
		JOIN book_files book ON book.id=session.book_file_id
		WHERE session.user_id=$1 AND session.active_seconds > 0
		GROUP BY book.format ORDER BY 3 DESC,book.format`, userID)
	if err != nil {
		return ReadingStatistics{}, fmt.Errorf("load reading format breakdown: %w", err)
	}
	for formatRows.Next() {
		var item ReadingFormatBreakdown
		if err := formatRows.Scan(&item.Format, &item.BookCount, &item.ActiveSeconds); err != nil {
			formatRows.Close()
			return ReadingStatistics{}, err
		}
		statistics.Formats = append(statistics.Formats, item)
	}
	if err := formatRows.Err(); err != nil {
		formatRows.Close()
		return ReadingStatistics{}, err
	}
	formatRows.Close()

	categoryRows, err := s.pool.Query(ctx, `
		WITH per_book AS MATERIALIZED (
			SELECT session.book_file_id,COALESCE(SUM(session.active_seconds),0)::bigint AS active_seconds
			FROM reading_sessions session
			JOIN accessible_book_ids($1) accessible ON accessible.book_file_id=session.book_file_id
			WHERE session.user_id=$1 AND session.active_seconds > 0
			GROUP BY session.book_file_id
		)
		SELECT category.id,category.slug,category.name,COUNT(*)::int,COALESCE(SUM(per_book.active_seconds),0)::bigint
		FROM per_book
		JOIN book_files book ON book.id=per_book.book_file_id
		JOIN classification_decisions decision ON decision.edition_id=book.edition_id AND decision.status='accepted'
		JOIN categories category ON category.id=decision.category_id
		GROUP BY category.id,category.slug,category.name
		ORDER BY 5 DESC,4 DESC,category.name LIMIT 8`, userID)
	if err != nil {
		return ReadingStatistics{}, fmt.Errorf("load reading category breakdown: %w", err)
	}
	for categoryRows.Next() {
		var item ReadingCategoryBreakdown
		if err := categoryRows.Scan(&item.ID, &item.Slug, &item.Name, &item.BookCount, &item.ActiveSeconds); err != nil {
			categoryRows.Close()
			return ReadingStatistics{}, err
		}
		statistics.Categories = append(statistics.Categories, item)
	}
	if err := categoryRows.Err(); err != nil {
		categoryRows.Close()
		return ReadingStatistics{}, err
	}
	categoryRows.Close()

	finishedRows, err := s.pool.Query(ctx, `
		SELECT state.book_file_id,state.updated_at,state.total_active_seconds
		FROM reading_states state
		JOIN accessible_book_ids($1) accessible ON accessible.book_file_id=state.book_file_id
		WHERE state.user_id=$1 AND state.status='finished'
		ORDER BY state.updated_at DESC,state.book_file_id DESC LIMIT 6`, userID)
	if err != nil {
		return ReadingStatistics{}, fmt.Errorf("load recently finished books: %w", err)
	}
	type finishedMetric struct {
		bookFileID    int64
		finishedAt    time.Time
		activeSeconds int64
	}
	finished := make([]finishedMetric, 0, 6)
	bookIDs := make([]int64, 0, 6)
	for finishedRows.Next() {
		var item finishedMetric
		if err := finishedRows.Scan(&item.bookFileID, &item.finishedAt, &item.activeSeconds); err != nil {
			finishedRows.Close()
			return ReadingStatistics{}, err
		}
		finished = append(finished, item)
		bookIDs = append(bookIDs, item.bookFileID)
	}
	if err := finishedRows.Err(); err != nil {
		finishedRows.Close()
		return ReadingStatistics{}, err
	}
	finishedRows.Close()
	books, err := s.catalogBooksByID(ctx, bookIDs)
	if err != nil {
		return ReadingStatistics{}, err
	}
	for _, item := range finished {
		if book, found := books[item.bookFileID]; found {
			statistics.RecentlyFinished = append(statistics.RecentlyFinished, FinishedReadingBook{
				Book: book, FinishedAt: item.finishedAt, TotalActiveSeconds: item.activeSeconds,
			})
		}
	}
	return statistics, nil
}

func completeDailyActivity(now time.Time, days int, values map[string]int64) []DailyReadingActivity {
	if days < 1 {
		return []DailyReadingActivity{}
	}
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).AddDate(0, 0, -(days - 1))
	items := make([]DailyReadingActivity, 0, days)
	for index := 0; index < days; index++ {
		date := start.AddDate(0, 0, index).Format("2006-01-02")
		items = append(items, DailyReadingActivity{Date: date, ActiveSeconds: values[date]})
	}
	return items
}

func readingStreaks(activity []DailyReadingActivity) (int, int) {
	if len(activity) == 0 {
		return 0, 0
	}
	longest, current := 0, 0
	for _, day := range activity {
		if day.ActiveSeconds > 0 {
			current++
			if current > longest {
				longest = current
			}
		} else {
			current = 0
		}
	}
	return current, longest
}
