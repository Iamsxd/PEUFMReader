package aiclassificationjobs

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"peufmreader/internal/classification"
	"peufmreader/internal/metadata"
	"peufmreader/internal/store"
)

func TestHandlerKeepsProcessingAfterIndividualAIError(t *testing.T) {
	repository := &fakeRepository{
		ids: []int64{11, 12},
		books: map[int64]metadata.Result{
			11: {Title: "可分类书籍"},
			12: {Title: "服务暂不可用"},
		},
		categories: []store.Category{{Slug: "history", Name: "历史", Active: true}},
	}
	advisor := fakeAdvisor{}
	payload, err := json.Marshal(Payload{Scope: ScopeUnclassified, Limit: 2})
	if err != nil {
		t.Fatal(err)
	}

	value, err := Handler(repository, advisor)(context.Background(), store.BackgroundJob{Payload: payload})
	if err != nil {
		t.Fatalf("handler returned error: %v", err)
	}
	result, ok := value.(Result)
	if !ok {
		t.Fatalf("result type = %T, want Result", value)
	}
	if result.Total != 2 || result.SuggestedBooks != 1 || result.SuggestedCategories != 1 || result.Failed != 1 {
		t.Fatalf("unexpected batch result: %+v", result)
	}
	if len(repository.saved) != 1 || repository.saved[11][0].CategorySlug != "history" {
		t.Fatalf("saved suggestions: %#v", repository.saved)
	}
}

func TestHandlerRejectsInvalidBatchScope(t *testing.T) {
	payload, err := json.Marshal(Payload{Scope: "all", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, err = Handler(&fakeRepository{}, fakeAdvisor{})(context.Background(), store.BackgroundJob{Payload: payload})
	if err == nil {
		t.Fatal("expected invalid scope error")
	}
}

type fakeRepository struct {
	ids        []int64
	books      map[int64]metadata.Result
	categories []store.Category
	saved      map[int64][]classification.Suggestion
}

func (r *fakeRepository) ListUnclassifiedEditionIDsLimit(_ context.Context, _ int) ([]int64, error) {
	return append([]int64(nil), r.ids...), nil
}

func (r *fakeRepository) IsEditionUnclassified(_ context.Context, editionID int64) (bool, error) {
	_, ok := r.books[editionID]
	return ok, nil
}

func (r *fakeRepository) EditionMetadata(_ context.Context, editionID int64) (metadata.Result, bool, error) {
	book, ok := r.books[editionID]
	return book, ok, nil
}

func (r *fakeRepository) AddClassificationSuggestions(_ context.Context, editionID int64, suggestions []classification.Suggestion) error {
	if r.saved == nil {
		r.saved = make(map[int64][]classification.Suggestion)
	}
	r.saved[editionID] = append([]classification.Suggestion(nil), suggestions...)
	return nil
}

func (r *fakeRepository) ListCategories(_ context.Context) ([]store.Category, error) {
	return append([]store.Category(nil), r.categories...), nil
}

type fakeAdvisor struct{}

func (fakeAdvisor) Suggest(_ context.Context, book metadata.Result, _ []classification.CategoryOption) ([]classification.Suggestion, error) {
	if book.Title == "服务暂不可用" {
		return nil, errors.New("temporary AI provider error")
	}
	return []classification.Suggestion{{CategorySlug: "history", Confidence: 0.8, Reason: "题材明确", Status: "suggested"}}, nil
}
