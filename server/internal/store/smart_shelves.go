package store

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
)

type SmartShelfRules struct {
	Format       string `json:"format"`
	Status       string `json:"status"`
	Favorite     bool   `json:"favorite"`
	CategorySlug string `json:"categorySlug"`
}

func (r *SmartShelfRules) Valid() bool {
	r.Format = strings.ToLower(strings.TrimSpace(r.Format))
	r.Status = strings.ToLower(strings.TrimSpace(r.Status))
	r.CategorySlug = strings.TrimSpace(r.CategorySlug)
	formats := map[string]bool{"": true, "pdf": true, "epub": true, "mobi": true, "azw3": true}
	statuses := map[string]bool{"": true, "unread": true, "reading": true, "finished": true, "abandoned": true}
	return formats[r.Format] && statuses[r.Status] && len(r.CategorySlug) <= 100 &&
		(r.Format != "" || r.Status != "" || r.Favorite || r.CategorySlug != "")
}

func (s *Store) SavePersonalShelfWithRules(ctx context.Context, userID, id int64, name, description string, rules *SmartShelfRules) (PersonalShelf, bool, error) {
	kind := "manual"
	if rules != nil {
		if !rules.Valid() {
			return PersonalShelf{}, false, errors.New("invalid smart shelf rules")
		}
		kind = "smart"
	}
	var shelf PersonalShelf
	var err error
	if id == 0 {
		err = s.pool.QueryRow(ctx, `INSERT INTO personal_shelves(user_id,name,description,kind,rules) VALUES($1,$2,$3,$4,$5)
            RETURNING id,name,description,created_at,kind,rules`, userID, name, description, kind, rules).
			Scan(&shelf.ID, &shelf.Name, &shelf.Description, &shelf.CreatedAt, &shelf.Kind, &shelf.Rules)
	} else {
		// No implicit conversion: manual membership/order must never disappear.
		err = s.pool.QueryRow(ctx, `UPDATE personal_shelves SET name=$3,description=$4,rules=$5
            WHERE id=$2 AND user_id=$1 AND kind=$6 RETURNING id,name,description,created_at,kind,rules`, userID, id, name, description, rules, kind).
			Scan(&shelf.ID, &shelf.Name, &shelf.Description, &shelf.CreatedAt, &shelf.Kind, &shelf.Rules)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return shelf, false, nil
	}
	return shelf, err == nil, err
}
