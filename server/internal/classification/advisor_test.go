package classification

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestDeepSeekAdvisorUsesJSONModeAndProbe(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			if r.Header.Get("Authorization") != "Bearer test-key" {
				t.Fatalf("missing DeepSeek authorization header")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
		case "/v1/chat/completions":
			var request map[string]any
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Fatal(err)
			}
			if request["max_tokens"] != float64(900) {
				t.Fatalf("DeepSeek max_tokens=%v, want 900", request["max_tokens"])
			}
			responseFormat, ok := request["response_format"].(map[string]any)
			if !ok || responseFormat["type"] != "json_object" {
				t.Fatalf("DeepSeek request does not require JSON output: %#v", request["response_format"])
			}
			messages, ok := request["messages"].([]any)
			if !ok || len(messages) != 2 {
				t.Fatalf("DeepSeek messages=%#v", request["messages"])
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"choices": []any{map[string]any{"message": map[string]string{"content": "```json\n{\"suggestions\":[{\"categorySlug\":\"history\",\"confidence\":0.82,\"reason\":\"历史主题\"}]}\n```"}}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	advisor := NewAdvisor("deepseek", server.URL, "deepseek-v4-flash", "test-key", time.Second)
	if err := advisor.Probe(context.Background()); err != nil {
		t.Fatalf("probe DeepSeek: %v", err)
	}
	result, err := advisor.Suggest(context.Background(), metadata.Result{Title: "中国通史", Description: strings.Repeat("史", 5000)}, []CategoryOption{{Slug: "history", Name: "历史", ParentName: "人文"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 1 || result[0].CategorySlug != "history" || result[0].Source != "ai:deepseek:deepseek-v4-flash" {
		t.Fatalf("unexpected DeepSeek suggestions: %+v", result)
	}
}
