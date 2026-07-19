package classification

import (
	"fmt"
	"sort"
	"strings"
	"unicode"

	"peufmreader/internal/metadata"
)

type Suggestion struct {
	CategorySlug string  `json:"categorySlug"`
	Confidence   float64 `json:"confidence"`
	Reason       string  `json:"reason"`
	Source       string  `json:"source"`
	Status       string  `json:"status"`
}

type categoryRule struct {
	Slug     string
	Keywords []string
}

var rules = []categoryRule{
	{Slug: "science-fiction", Keywords: []string{"科幻", "science fiction", "sci-fi", "scifi", "太空歌剧", "cyberpunk", "赛博朋克"}},
	{Slug: "fantasy", Keywords: []string{"奇幻", "fantasy", "魔法", "玄幻", "仙侠"}},
	{Slug: "mystery", Keywords: []string{"悬疑", "推理", "侦探", "mystery", "detective", "thriller", "crime fiction"}},
	{Slug: "romance", Keywords: []string{"爱情", "言情", "romance", "love story"}},
	{Slug: "history", Keywords: []string{"历史", "history", "historical", "史学", "考古"}},
	{Slug: "biography", Keywords: []string{"传记", "自传", "回忆录", "biography", "autobiography", "memoir"}},
	{Slug: "business", Keywords: []string{"商业", "经济", "管理", "金融", "投资", "business", "economics", "finance", "management", "marketing"}},
	{Slug: "technology", Keywords: []string{"计算机", "编程", "软件", "人工智能", "机器学习", "technology", "computer", "programming", "software", "artificial intelligence", "machine learning"}},
	{Slug: "science", Keywords: []string{"科学", "物理", "化学", "生物", "数学", "天文", "science", "physics", "chemistry", "biology", "mathematics", "astronomy"}},
	{Slug: "philosophy", Keywords: []string{"哲学", "伦理", "逻辑学", "philosophy", "ethics", "logic"}},
	{Slug: "social-sciences", Keywords: []string{"社会科学", "社会学", "政治学", "心理学", "人类学", "sociology", "politics", "psychology", "anthropology"}},
	{Slug: "art", Keywords: []string{"艺术", "绘画", "摄影", "音乐", "设计", "art", "painting", "photography", "music", "design"}},
	{Slug: "children", Keywords: []string{"少儿", "儿童", "童话", "绘本", "children", "juvenile", "picture book"}},
	{Slug: "education", Keywords: []string{"教育", "教材", "教学", "考试", "education", "textbook", "teaching", "study guide"}},
	{Slug: "health", Keywords: []string{"健康", "医学", "医疗", "营养", "health", "medicine", "medical", "nutrition"}},
	{Slug: "travel", Keywords: []string{"旅行", "旅游", "游记", "travel", "guidebook"}},
	{Slug: "reference", Keywords: []string{"工具书", "字典", "词典", "百科", "手册", "reference", "dictionary", "encyclopedia", "handbook"}},
	{Slug: "literature", Keywords: []string{"文学", "小说", "诗歌", "散文", "literature", "fiction", "poetry", "novel", "essays"}},
}

func Classify(book metadata.Result) []Suggestion {
	title := normalize(book.Title)
	description := normalize(book.Description)
	subjects := make([]string, 0, len(book.Subjects))
	for _, subject := range book.Subjects {
		subjects = append(subjects, normalize(subject))
	}

	suggestions := make([]Suggestion, 0, 3)
	for _, rule := range rules {
		score, reason := scoreRule(rule, title, description, subjects)
		if score < 0.65 {
			continue
		}
		status := "suggested"
		if score >= 0.9 {
			status = "accepted"
		}
		suggestions = append(suggestions, Suggestion{
			CategorySlug: rule.Slug,
			Confidence:   score,
			Reason:       reason,
			Source:       "deterministic-rules-v1",
			Status:       status,
		})
	}
	sort.SliceStable(suggestions, func(i, j int) bool { return suggestions[i].Confidence > suggestions[j].Confidence })
	if len(suggestions) > 3 {
		suggestions = suggestions[:3]
	}
	if len(suggestions) == 0 {
		return []Suggestion{{
			CategorySlug: "other",
			Confidence:   0.35,
			Reason:       "没有规则达到自动分类阈值",
			Source:       "deterministic-rules-v1",
			Status:       "suggested",
		}}
	}
	return suggestions
}

func scoreRule(rule categoryRule, title, description string, subjects []string) (float64, string) {
	for _, keyword := range rule.Keywords {
		normalizedKeyword := normalize(keyword)
		for _, subject := range subjects {
			if subject == normalizedKeyword {
				return 0.96, fmt.Sprintf("内嵌题材与规则 %q 精确匹配", keyword)
			}
			if containsTerm(subject, normalizedKeyword) {
				return 0.91, fmt.Sprintf("内嵌题材包含规则 %q", keyword)
			}
		}
	}
	for _, keyword := range rule.Keywords {
		if containsTerm(title, normalize(keyword)) {
			return 0.76, fmt.Sprintf("书名包含规则 %q", keyword)
		}
	}
	for _, keyword := range rule.Keywords {
		if containsTerm(description, normalize(keyword)) {
			return 0.68, fmt.Sprintf("简介包含规则 %q", keyword)
		}
	}
	return 0, ""
}

func containsTerm(text, term string) bool {
	if text == "" || term == "" {
		return false
	}
	if containsCJK(term) {
		return strings.Contains(text, term)
	}
	return strings.Contains(" "+text+" ", " "+term+" ")
}

func containsCJK(value string) bool {
	for _, current := range value {
		if unicode.Is(unicode.Han, current) {
			return true
		}
	}
	return false
}

func normalize(value string) string {
	return strings.Join(strings.Fields(strings.ToLower(value)), " ")
}
