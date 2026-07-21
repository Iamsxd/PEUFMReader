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

type Rule struct {
	Slug     string
	Keywords []string
}

var rules = []Rule{
	{Slug: "true-crime", Keywords: []string{"纪实犯罪", "真实犯罪", "true crime"}},
	{Slug: "horror", Keywords: []string{"恐怖", "惊悚", "horror", "supernatural horror"}},
	{Slug: "historical-fiction", Keywords: []string{"历史小说", "historical fiction"}},
	{Slug: "comics", Keywords: []string{"漫画", "图像小说", "comic", "comics", "graphic novel", "manga"}},
	{Slug: "psychology", Keywords: []string{"心理学", "心理咨询", "psychology", "psychotherapy"}},
	{Slug: "politics-law", Keywords: []string{"政治", "法律", "法学", "国际关系", "politics", "law", "legal", "international relations"}},
	{Slug: "management", Keywords: []string{"管理学", "企业管理", "领导力", "management", "leadership"}},
	{Slug: "finance-investment", Keywords: []string{"金融", "投资", "股票", "理财", "finance", "investment", "investing", "stock market"}},
	{Slug: "programming", Keywords: []string{"编程", "程序设计", "软件开发", "programming", "software development", "coding"}},
	{Slug: "ai-data", Keywords: []string{"人工智能", "机器学习", "深度学习", "数据科学", "artificial intelligence", "machine learning", "deep learning", "data science"}},
	{Slug: "cybersecurity", Keywords: []string{"网络安全", "信息安全", "密码学", "cybersecurity", "information security", "cryptography"}},
	{Slug: "engineering", Keywords: []string{"工程", "机械", "电子工程", "engineering", "mechanical engineering", "electrical engineering"}},
	{Slug: "mathematics", Keywords: []string{"数学", "代数", "几何", "微积分", "mathematics", "algebra", "geometry", "calculus"}},
	{Slug: "earth-environment", Keywords: []string{"地球科学", "环境", "生态", "气候", "earth science", "environment", "ecology", "climate"}},
	{Slug: "medicine", Keywords: []string{"医学", "临床", "疾病", "medicine", "medical", "clinical"}},
	{Slug: "sports-fitness", Keywords: []string{"运动", "健身", "体育", "sports", "fitness", "exercise"}},
	{Slug: "self-help", Keywords: []string{"个人成长", "自我提升", "习惯", "励志", "self-help", "personal development", "habits"}},
	{Slug: "cooking-food", Keywords: []string{"烹饪", "食谱", "美食", "饮食", "cooking", "recipe", "food"}},
	{Slug: "parenting-family", Keywords: []string{"亲子", "育儿", "家庭教育", "parenting", "family"}},
	{Slug: "language-learning", Keywords: []string{"语言学习", "英语学习", "语法", "外语", "language learning", "grammar"}},
	{Slug: "exams", Keywords: []string{"考试", "考研", "公务员考试", "资格考试", "exam", "test preparation", "study guide"}},
	{Slug: "science-fiction", Keywords: []string{"科幻", "science fiction", "sci-fi", "scifi", "太空歌剧", "cyberpunk", "赛博朋克"}},
	{Slug: "fantasy", Keywords: []string{"奇幻", "fantasy", "魔法", "玄幻", "仙侠"}},
	{Slug: "mystery", Keywords: []string{"悬疑", "推理", "侦探", "mystery", "detective", "thriller", "crime fiction"}},
	{Slug: "romance", Keywords: []string{"爱情", "言情", "romance", "love story"}},
	{Slug: "history", Keywords: []string{"历史", "history", "historical", "史学", "考古"}},
	{Slug: "biography", Keywords: []string{"传记", "自传", "回忆录", "biography", "autobiography", "memoir"}},
	{Slug: "business", Keywords: []string{"商业", "经济", "business", "economics"}},
	{Slug: "technology", Keywords: []string{"计算机", "软件", "技术", "technology", "computer", "software"}},
	{Slug: "science", Keywords: []string{"科学", "物理", "化学", "生物", "天文", "science", "physics", "chemistry", "biology", "astronomy"}},
	{Slug: "philosophy", Keywords: []string{"哲学", "伦理", "逻辑学", "philosophy", "ethics", "logic"}},
	{Slug: "social-sciences", Keywords: []string{"社会科学", "社会学", "人类学", "sociology", "anthropology"}},
	{Slug: "art", Keywords: []string{"艺术", "绘画", "摄影", "音乐", "设计", "art", "painting", "photography", "music", "design"}},
	{Slug: "children", Keywords: []string{"少儿", "儿童", "童话", "绘本", "children", "juvenile", "picture book"}},
	{Slug: "education", Keywords: []string{"教育", "教材", "教学", "education", "textbook", "teaching"}},
	{Slug: "health", Keywords: []string{"健康", "医疗", "营养", "health", "nutrition"}},
	{Slug: "travel", Keywords: []string{"旅行", "旅游", "游记", "travel", "guidebook"}},
	{Slug: "reference", Keywords: []string{"工具书", "字典", "词典", "百科", "手册", "reference", "dictionary", "encyclopedia", "handbook"}},
	{Slug: "literature", Keywords: []string{"文学", "小说", "诗歌", "散文", "literature", "fiction", "poetry", "novel", "essays"}},
}

func Classify(book metadata.Result) []Suggestion {
	return ClassifyWithRules(book, rules)
}

func DefaultRules() []Rule {
	result := make([]Rule, 0, len(rules))
	for _, rule := range rules {
		result = append(result, Rule{Slug: rule.Slug, Keywords: append([]string(nil), rule.Keywords...)})
	}
	return result
}

func ClassifyWithRules(book metadata.Result, configured []Rule) []Suggestion {
	if len(configured) == 0 {
		configured = rules
	}
	title := normalize(book.Title)
	description := normalize(book.Description)
	subjects := make([]string, 0, len(book.Subjects))
	for _, subject := range book.Subjects {
		subjects = append(subjects, normalize(subject))
	}

	suggestions := make([]Suggestion, 0, 3)
	for _, rule := range configured {
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

func scoreRule(rule Rule, title, description string, subjects []string) (float64, string) {
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
