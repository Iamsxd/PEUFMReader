package classification

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"peufmreader/internal/metadata"
)

type CategoryOption struct {
	Slug       string `json:"slug"`
	Name       string `json:"name"`
	ParentName string `json:"parentName,omitempty"`
}

type Advisor struct {
	provider string
	baseURL  string
	model    string
	apiKey   string
	client   *http.Client
}

func NewAdvisor(provider, baseURL, model, apiKey string, timeout time.Duration) *Advisor {
	if provider == "" {
		return nil
	}
	return &Advisor{
		provider: provider,
		baseURL:  strings.TrimRight(baseURL, "/"),
		model:    model,
		apiKey:   apiKey,
		client:   &http.Client{Timeout: timeout},
	}
}

func (a *Advisor) Suggest(ctx context.Context, book metadata.Result, categories []CategoryOption) ([]Suggestion, error) {
	if a == nil {
		return nil, errors.New("AI classification is disabled")
	}
	if len(categories) == 0 {
		return nil, errors.New("AI classification requires at least one active category")
	}
	allowed := make(map[string]bool, len(categories))
	for _, category := range categories {
		allowed[category.Slug] = true
	}
	promptBytes, _ := json.Marshal(map[string]any{
		"title":         truncateAIText(book.Title, 500),
		"authors":       truncateAIValues(book.Authors, 32, 300),
		"publishedYear": book.PublishedYear,
		"language":      truncateAIText(book.Language, 35),
		"description":   truncateAIText(book.Description, 4000),
		"subjects":      truncateAIValues(book.Subjects, 24, 200),
		"allowed":       categories,
	})
	prompt := "你是电子书分类助手。只能从 allowed 中选择最多三个 categorySlug。返回 JSON 对象，包含 suggestions 数组；每项包含 categorySlug、confidence(0到1)和简短 reason。不要创造新分类。输入：" + string(promptBytes)

	var content string
	var err error
	switch a.provider {
	case "ollama":
		content, err = a.callOllama(ctx, prompt, categories)
	case "openai-compatible":
		content, err = a.callOpenAICompatible(ctx, prompt, false)
	case "deepseek":
		content, err = a.callOpenAICompatible(ctx, prompt, true)
	default:
		return nil, fmt.Errorf("unsupported AI provider %q", a.provider)
	}
	if err != nil {
		return nil, err
	}
	var response struct {
		Suggestions []struct {
			CategorySlug string  `json:"categorySlug"`
			Confidence   float64 `json:"confidence"`
			Reason       string  `json:"reason"`
		} `json:"suggestions"`
	}
	if err := json.Unmarshal([]byte(stripJSONFence(content)), &response); err != nil {
		return nil, fmt.Errorf("parse AI classification JSON: %w", err)
	}
	result := make([]Suggestion, 0, 3)
	seen := make(map[string]bool)
	for _, item := range response.Suggestions {
		slug := strings.TrimSpace(item.CategorySlug)
		reason := strings.TrimSpace(item.Reason)
		if !allowed[slug] || seen[slug] || item.Confidence < 0 || item.Confidence > 1 || reason == "" {
			continue
		}
		if len(reason) > 500 {
			reason = reason[:500]
		}
		confidence := min(item.Confidence, 0.89)
		result = append(result, Suggestion{
			CategorySlug: slug,
			Confidence:   confidence,
			Reason:       reason,
			Source:       "ai:" + a.provider + ":" + a.model,
			Status:       "suggested",
		})
		seen[slug] = true
		if len(result) == 3 {
			break
		}
	}
	if len(result) == 0 {
		return nil, errors.New("AI returned no valid controlled-category suggestions")
	}
	return result, nil
}

func (a *Advisor) Provider() string {
	if a == nil {
		return ""
	}
	return a.provider
}

func (a *Advisor) Model() string {
	if a == nil {
		return ""
	}
	return a.model
}

// Probe verifies connectivity without transmitting any book metadata.
func (a *Advisor) Probe(ctx context.Context) error {
	if a == nil {
		return errors.New("AI classification is disabled")
	}
	endpoint := a.baseURL + "/v1/models"
	if a.provider == "ollama" {
		endpoint = a.baseURL + "/api/tags"
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	if a.apiKey != "" {
		request.Header.Set("Authorization", "Bearer "+a.apiKey)
	}
	response, err := a.client.Do(request)
	if err != nil {
		return fmt.Errorf("call AI provider: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 16<<10))
		return fmt.Errorf("AI provider returned %d: %s", response.StatusCode, strings.TrimSpace(string(message)))
	}
	return nil
}

func (a *Advisor) callOllama(ctx context.Context, prompt string, categories []CategoryOption) (string, error) {
	enum := make([]string, 0, len(categories))
	for _, category := range categories {
		enum = append(enum, category.Slug)
	}
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"suggestions": map[string]any{
				"type":     "array",
				"maxItems": 3,
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"categorySlug": map[string]any{"type": "string", "enum": enum},
						"confidence":   map[string]any{"type": "number", "minimum": 0, "maximum": 1},
						"reason":       map[string]any{"type": "string"},
					},
					"required":             []string{"categorySlug", "confidence", "reason"},
					"additionalProperties": false,
				},
			},
		},
		"required":             []string{"suggestions"},
		"additionalProperties": false,
	}
	body := map[string]any{
		"model":    a.model,
		"stream":   false,
		"messages": []map[string]string{{"role": "user", "content": prompt}},
		"format":   schema,
		"options":  map[string]any{"temperature": 0},
	}
	var response struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	}
	if err := a.postJSON(ctx, a.baseURL+"/api/chat", body, &response); err != nil {
		return "", err
	}
	return response.Message.Content, nil
}

func (a *Advisor) callOpenAICompatible(ctx context.Context, prompt string, jsonMode bool) (string, error) {
	body := map[string]any{
		"model":       a.model,
		"stream":      false,
		"temperature": 0,
		"messages": []map[string]string{
			{"role": "system", "content": "你是电子书分类助手。必须只输出合法 JSON 对象，不要输出 Markdown 或额外解释。"},
			{"role": "user", "content": prompt},
		},
	}
	if jsonMode {
		body["response_format"] = map[string]string{"type": "json_object"}
		body["max_tokens"] = 900
	}
	var response struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := a.postJSON(ctx, a.baseURL+"/v1/chat/completions", body, &response); err != nil {
		return "", err
	}
	if len(response.Choices) == 0 {
		return "", errors.New("AI provider returned no choices")
	}
	return response.Choices[0].Message.Content, nil
}

func stripJSONFence(content string) string {
	content = strings.TrimSpace(content)
	if !strings.HasPrefix(content, "```") || !strings.HasSuffix(content, "```") {
		return content
	}
	content = strings.TrimPrefix(content, "```")
	if newline := strings.IndexByte(content, '\n'); newline >= 0 {
		content = content[newline+1:]
	}
	return strings.TrimSpace(strings.TrimSuffix(content, "```"))
}

func truncateAIText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if limit <= 0 || len([]rune(value)) <= limit {
		return value
	}
	return string([]rune(value)[:limit])
}

func truncateAIValues(values []string, limit, itemLimit int) []string {
	if limit <= 0 || len(values) == 0 {
		return []string{}
	}
	result := make([]string, 0, min(len(values), limit))
	for _, value := range values {
		value = truncateAIText(value, itemLimit)
		if value == "" {
			continue
		}
		result = append(result, value)
		if len(result) == limit {
			break
		}
	}
	return result
}

func (a *Advisor) postJSON(ctx context.Context, endpoint string, body, response any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	if a.apiKey != "" {
		request.Header.Set("Authorization", "Bearer "+a.apiKey)
	}
	httpResponse, err := a.client.Do(request)
	if err != nil {
		return fmt.Errorf("call AI provider: %w", err)
	}
	defer httpResponse.Body.Close()
	if httpResponse.StatusCode < 200 || httpResponse.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(httpResponse.Body, 16<<10))
		return fmt.Errorf("AI provider returned %d: %s", httpResponse.StatusCode, strings.TrimSpace(string(message)))
	}
	decoder := json.NewDecoder(io.LimitReader(httpResponse.Body, 1<<20))
	if err := decoder.Decode(response); err != nil {
		return fmt.Errorf("decode AI provider response: %w", err)
	}
	return nil
}
