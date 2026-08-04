package database

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMigrateAllFilesIsRepeatable(t *testing.T) {
	baseURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if baseURL == "" {
		t.Skip("TEST_DATABASE_URL is required for PostgreSQL migration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, baseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("migration_test_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+identifier+" CASCADE")
		admin.Close()
	})

	config, err := pgxpool.ParseConfig(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	if err := Migrate(ctx, pool); err != nil {
		t.Fatalf("first migration run failed: %v", err)
	}
	if err := Migrate(ctx, pool); err != nil {
		t.Fatalf("repeat migration run failed: %v", err)
	}

	entries, err := fs.ReadDir(migrationFiles, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	expected := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			expected++
		}
	}
	var applied int
	if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM schema_migrations").Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if applied != expected {
		t.Fatalf("applied migrations=%d want=%d", applied, expected)
	}
}
