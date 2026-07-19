package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type AuditEvent struct {
	ID         int64           `json:"id"`
	ActorID    *int64          `json:"actorId,omitempty"`
	ActorName  string          `json:"actorName"`
	Action     string          `json:"action"`
	ClientIP   string          `json:"clientIp"`
	StatusCode int             `json:"statusCode"`
	Details    json.RawMessage `json:"details"`
	CreatedAt  time.Time       `json:"createdAt"`
}

func (s *Store) RecordAuditEvent(ctx context.Context, actorID *int64, actorName, action, clientIP string, statusCode int, details map[string]any) error {
	action = strings.TrimSpace(action)
	if action == "" {
		return fmt.Errorf("audit action is required")
	}
	if details == nil {
		details = map[string]any{}
	}
	encoded, err := json.Marshal(details)
	if err != nil {
		return fmt.Errorf("encode audit details: %w", err)
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO audit_events(actor_id,actor_name,action,client_ip,status_code,details)
		VALUES ($1,$2,$3,$4,$5,$6)`, actorID, strings.TrimSpace(actorName), action, strings.TrimSpace(clientIP), statusCode, encoded)
	if err != nil {
		return fmt.Errorf("record audit event: %w", err)
	}
	return nil
}

func (s *Store) ListAuditEvents(ctx context.Context, limit int) ([]AuditEvent, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id,actor_id,actor_name,action,client_ip,status_code,details,created_at
		FROM audit_events ORDER BY created_at DESC,id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("list audit events: %w", err)
	}
	defer rows.Close()
	items := make([]AuditEvent, 0)
	for rows.Next() {
		var item AuditEvent
		if err := rows.Scan(&item.ID, &item.ActorID, &item.ActorName, &item.Action, &item.ClientIP, &item.StatusCode, &item.Details, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
