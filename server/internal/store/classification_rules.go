package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"peufmreader/internal/classification"
)

type ClassificationRule struct {
	ID           int64     `json:"id"`
	CategoryID   int64     `json:"categoryId"`
	CategorySlug string    `json:"categorySlug"`
	CategoryName string    `json:"categoryName"`
	Keywords     []string  `json:"keywords"`
	Enabled      bool      `json:"enabled"`
	Priority     int       `json:"priority"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

func (s *Store) EnsureClassificationRules(ctx context.Context, defaults []classification.Rule) error {
	for index, rule := range defaults {
		_, err := s.pool.Exec(ctx, `
			INSERT INTO classification_rules(category_id,keywords,enabled,priority)
			SELECT id,$1,true,$2 FROM categories WHERE slug=$3
			ON CONFLICT (category_id) DO NOTHING`, normalizedKeywords(rule.Keywords), (index+1)*10, rule.Slug)
		if err != nil {
			return fmt.Errorf("ensure classification rule %s: %w", rule.Slug, err)
		}
	}
	return nil
}

func (s *Store) ListClassificationRules(ctx context.Context, enabledOnly bool) ([]ClassificationRule, error) {
	where := ""
	if enabledOnly {
		where = " WHERE r.enabled=true AND c.active=true"
	}
	rows, err := s.pool.Query(ctx, `SELECT r.id,c.id,c.slug,c.name,r.keywords,r.enabled,r.priority,r.updated_at
		FROM classification_rules r JOIN categories c ON c.id=r.category_id`+where+` ORDER BY r.priority,c.name`)
	if err != nil {
		return nil, fmt.Errorf("list classification rules: %w", err)
	}
	defer rows.Close()
	items := make([]ClassificationRule, 0)
	for rows.Next() {
		var item ClassificationRule
		if err := rows.Scan(&item.ID, &item.CategoryID, &item.CategorySlug, &item.CategoryName, &item.Keywords, &item.Enabled, &item.Priority, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) EnabledClassificationRules(ctx context.Context) ([]classification.Rule, error) {
	items, err := s.ListClassificationRules(ctx, true)
	if err != nil {
		return nil, err
	}
	rules := make([]classification.Rule, 0, len(items))
	for _, item := range items {
		rules = append(rules, classification.Rule{Slug: item.CategorySlug, Keywords: item.Keywords})
	}
	return rules, nil
}

func (s *Store) UpdateClassificationRule(ctx context.Context, id int64, keywords []string, enabled bool, priority int) (ClassificationRule, bool, error) {
	keywords = normalizedKeywords(keywords)
	if priority < 1 || priority > 10000 || len(keywords) > 200 {
		return ClassificationRule{}, false, fmt.Errorf("invalid classification rule")
	}
	var item ClassificationRule
	err := s.pool.QueryRow(ctx, `UPDATE classification_rules r SET keywords=$1,enabled=$2,priority=$3,updated_at=now()
		FROM categories c WHERE r.id=$4 AND c.id=r.category_id
		RETURNING r.id,c.id,c.slug,c.name,r.keywords,r.enabled,r.priority,r.updated_at`, keywords, enabled, priority, id).
		Scan(&item.ID, &item.CategoryID, &item.CategorySlug, &item.CategoryName, &item.Keywords, &item.Enabled, &item.Priority, &item.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ClassificationRule{}, false, nil
		}
		return ClassificationRule{}, false, fmt.Errorf("update classification rule: %w", err)
	}
	return item, true, nil
}

func normalizedKeywords(values []string) []string {
	seen := make(map[string]bool)
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		key := strings.ToLower(value)
		if value == "" || seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, value)
	}
	return result
}
