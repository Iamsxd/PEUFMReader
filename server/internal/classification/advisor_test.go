package classification

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"peufmreader/internal/metadata"
)

func TestOllamaAdvisorUsesSchemaAndFiltersOutput(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/chat" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if request["stream"] != false {
			t.Fatal("Ollama request must disable streaming")
		}
		if _, ok := request["format"].(map[string]any); !ok {
			t.Fatal("Ollama request is missing JSON schema")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"message": map[string]string{"content": `{"suggestions":[{"categorySlug":"science-fiction","confidence":0.97,"reason":"题材明确"},{"categorySlug":"invented","confidence":1,"reason":"invalid"}]}`},
		})
	}))
	defer server.Close()

	advisor := NewAdvisor("ollama", server.URL, "test-model", "", time.Second)
	result, err := advisor.Suggest(context.Background(), metadata.Result{Title: "三体"}, []CategoryOption{{Slug: "science-fiction", Name: "科幻"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 1 || result[0].CategorySlug != "science-fiction" || result[0].Confidence != 0.89 || result[0].Status != "suggested" {
		t.Fatalf("unexpected AI suggestions: %+v", result)
	}
}
