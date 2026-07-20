package store

import (
	"strings"
	"testing"
)

func TestNormalizeCatalogQuery(t *testing.T) {
	query := NormalizeCatalogQuery(CatalogQuery{Query: "  三体  ", Format: "PDF", Status: "READING", Page: -2, PageSize: 999})
	if query.Query != "三体" || query.Format != "pdf" || query.Status != "reading" {
		t.Fatalf("query was not normalized: %#v", query)
	}
	if query.Page != 1 || query.PageSize != DefaultCatalogPageSize || query.Sort != "title" {
		t.Fatalf("pagination defaults not applied: %#v", query)
	}
}

func TestBuildCatalogWhereUsesBoundParameters(t *testing.T) {
	where, args, searchPlaceholder := buildCatalogWhere(42, CatalogQuery{
		Query: "100%_Go", CategorySlug: "technology", Format: "pdf", Status: "reading",
	})
	if len(args) != 5 || searchPlaceholder != "$1" {
		t.Fatalf("unexpected arguments: placeholder=%q args=%#v", searchPlaceholder, args)
	}
	if strings.Contains(where, "100%_Go") || !strings.Contains(where, "filter_rs.user_id=$4") || !strings.Contains(where, "filter_rs.status=$5") {
		t.Fatalf("query values were not safely bound: %s", where)
	}
	if args[0] != `100\%\_Go` {
		t.Fatalf("LIKE pattern was not escaped: %q", args[0])
	}
}

func TestCatalogOrderByOnlyUsesKnownValues(t *testing.T) {
	if got := catalogOrderBy("unknown", ""); got != " ORDER BY w.sort_title,bf.id" {
		t.Fatalf("unknown sort changed SQL: %q", got)
	}
	if got := catalogOrderBy("relevance", "$1"); !strings.Contains(got, "lower($1)") {
		t.Fatalf("relevance sort did not reuse search parameter: %q", got)
	}
}

func TestReviewItemSelectHidesSupersededMetadataEvidence(t *testing.T) {
	if !strings.Contains(reviewItemSelect, "mc.status IN ('accepted','suggested')") {
		t.Fatal("review query does not limit metadata evidence to current candidates")
	}
}

func TestReviewMetadataEqualIgnoresCategoriesAndAuthorWhitespace(t *testing.T) {
	year := 2018
	current := ReviewInput{
		Title: "一个人的村庄", Authors: []string{"刘亮程"}, PublishedYear: &year,
		Language: "zh-cn", ISBN: "3953805105", Publisher: "江西人民出版社",
	}
	next := current
	next.Authors = []string{" 刘亮程 ", "刘亮程"}
	next.CategorySlugs = []string{"literature"}
	if !reviewMetadataEqual(current, next) {
		t.Fatal("equivalent review metadata was treated as changed")
	}

	changed := next
	changed.Publisher = "新的出版社"
	if reviewMetadataEqual(current, changed) {
		t.Fatal("changed review metadata was treated as equivalent")
	}
}
