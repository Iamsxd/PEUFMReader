package classification

import (
	"fmt"
	"sort"
	"strings"
	"unicode"

	"peufmreader/internal/metadata"
)

const (
	DefaultRuleVersion  = 2
	autoAcceptThreshold = 0.84
	minimumScore        = 0.65
)

type Suggestion struct {
	CategorySlug string  `json:"categorySlug"`
	Confidence   float64 `json:"confidence"`
	Reason       string  `json:"reason"`
	Source       string  `json:"source"`
	Status       string  `json:"status"`
}

type Rule struct {
	Slug           string
	Keywords       []string
	StrongKeywords []string
	Priority       int
	Version        int
}

// Strong keywords are sufficiently distinctive to accept a title-only match.
// Regular keywords need a subject match or corroborating evidence from another field.
var rules = []Rule{
	{Slug: "true-crime", StrongKeywords: []string{"纪实犯罪", "真实犯罪", "犯罪纪实", "true crime"}, Keywords: []string{"犯罪案件", "刑事案件"}},
	{Slug: "horror", StrongKeywords: []string{"恐怖小说", "惊悚小说", "horror fiction", "supernatural horror"}, Keywords: []string{"恐怖", "惊悚", "灵异", "horror"}},
	{Slug: "historical-fiction", StrongKeywords: []string{"历史小说", "historical fiction"}, Keywords: []string{"架空历史", "历史题材小说"}},
	{Slug: "contemporary-fiction", StrongKeywords: []string{"当代小说", "现代小说", "contemporary fiction", "literary fiction"}, Keywords: []string{"当代文学", "现代文学"}},
	{Slug: "comics", StrongKeywords: []string{"漫画", "图像小说", "连环画", "graphic novel", "manga"}, Keywords: []string{"comic", "comics"}},
	{Slug: "poetry", StrongKeywords: []string{"诗集", "诗选", "古诗词", "poetry collection"}, Keywords: []string{"诗歌", "诗词", "poetry"}},
	{Slug: "essays", StrongKeywords: []string{"散文集", "随笔集", "杂文集", "essay collection"}, Keywords: []string{"散文", "随笔", "杂文", "essays"}},
	{Slug: "humor", StrongKeywords: []string{"幽默文学", "笑话大全", "humor writing"}, Keywords: []string{"幽默", "笑话", "喜剧", "humor"}},
	{Slug: "chinese-classics", StrongKeywords: []string{"朱子家训", "颜氏家训", "家训", "四书五经", "诸子百家", "国学经典", "古籍整理"}, Keywords: []string{"国学", "经史子集", "儒家经典", "中国古典"}},
	{Slug: "classics", StrongKeywords: []string{"世界名著", "文学名著", "classic literature"}, Keywords: []string{"经典文学", "古典文学", "classics"}},
	{Slug: "psychology", StrongKeywords: []string{"心理学", "心理咨询", "心理治疗", "psychotherapy"}, Keywords: []string{"心理", "认知", "情绪", "psychology"}},
	{Slug: "interpersonal-communication", StrongKeywords: []string{"人际关系", "人际交往", "沟通技巧", "社交技巧", "社会化攻略", "i人", "communication skills"}, Keywords: []string{"社交", "沟通", "内向", "情商", "interpersonal"}},
	{Slug: "politics-law", StrongKeywords: []string{"政治学", "法学", "国际关系", "宪法学", "political science", "international relations"}, Keywords: []string{"政治", "法律", "法治", "legal", "politics", "law"}},
	{Slug: "military", StrongKeywords: []string{"军事史", "战争史", "军事战略", "军事理论", "military history"}, Keywords: []string{"军事", "战争", "战役", "武器", "military"}},
	{Slug: "management", StrongKeywords: []string{"管理学", "企业管理", "领导力", "组织管理", "management science"}, Keywords: []string{"管理", "领导", "组织", "management", "leadership"}},
	{Slug: "finance-investment", StrongKeywords: []string{"投资理财", "股票投资", "证券投资", "基金投资", "finance and investment"}, Keywords: []string{"金融", "投资", "股票", "基金", "理财", "finance", "investing"}},
	{Slug: "marketing", StrongKeywords: []string{"市场营销", "品牌营销", "数字营销", "营销管理", "marketing"}, Keywords: []string{"营销", "品牌", "广告", "销售", "market"}},
	{Slug: "programming", StrongKeywords: []string{"编程入门", "程序设计", "软件开发", "代码大全", "编程实战"}, Keywords: []string{"编程", "代码", "programming", "software development", "coding"}},
	{Slug: "ai-data", StrongKeywords: []string{"人工智能", "机器学习", "深度学习", "数据科学", "大语言模型", "artificial intelligence", "machine learning", "deep learning", "data science"}, Keywords: []string{"神经网络", "数据分析", "算法模型", "AI", "LLM"}},
	{Slug: "cybersecurity", StrongKeywords: []string{"网络安全", "信息安全", "密码学", "渗透测试", "cybersecurity", "information security"}, Keywords: []string{"安全攻防", "黑客", "cryptography"}},
	{Slug: "engineering", StrongKeywords: []string{"机械工程", "电子工程", "电气工程", "土木工程", "engineering"}, Keywords: []string{"工程", "机械", "电子", "电气"}},
	{Slug: "mathematics", StrongKeywords: []string{"高等数学", "线性代数", "微积分", "概率论", "mathematics"}, Keywords: []string{"数学", "代数", "几何", "统计学", "calculus"}},
	{Slug: "earth-environment", StrongKeywords: []string{"地球科学", "环境科学", "生态学", "气候变化", "earth science"}, Keywords: []string{"环境", "生态", "气候", "地理", "ecology"}},
	{Slug: "medicine", StrongKeywords: []string{"临床医学", "医学教材", "疾病诊疗", "medical science"}, Keywords: []string{"医学", "临床", "疾病", "诊疗", "medicine", "medical"}},
	{Slug: "sports-fitness", StrongKeywords: []string{"健身训练", "运动训练", "体育运动", "fitness training"}, Keywords: []string{"运动", "健身", "体育", "exercise", "fitness"}},
	{Slug: "self-help", StrongKeywords: []string{"个人成长", "自我提升", "习惯养成", "时间管理", "self-help", "personal development"}, Keywords: []string{"成长", "习惯", "励志", "效率", "自律"}},
	{Slug: "minimalist-living", StrongKeywords: []string{"极简主义", "极简生活", "断舍离", "minimalist living", "minimalism"}, Keywords: []string{"极简", "整理收纳", "简约生活"}},
	{Slug: "cooking-food", StrongKeywords: []string{"食谱", "菜谱", "烹饪", "美食制作", "recipe book"}, Keywords: []string{"美食", "饮食", "料理", "cooking", "food"}},
	{Slug: "parenting-family", StrongKeywords: []string{"亲子教育", "家庭教育", "育儿百科", "parenting"}, Keywords: []string{"亲子", "育儿", "家庭", "family"}},
	{Slug: "home-gardening", StrongKeywords: []string{"家居设计", "室内设计", "园艺", "家庭园艺", "home gardening"}, Keywords: []string{"家居", "装修", "花园", "gardening"}},
	{Slug: "crafts-hobbies", StrongKeywords: []string{"手工制作", "编织教程", "模型制作", "crafts and hobbies"}, Keywords: []string{"手工", "编织", "折纸", "模型", "crafts"}},
	{Slug: "language-learning", StrongKeywords: []string{"语言学习", "英语学习", "日语学习", "汉语学习", "外语学习", "language learning"}, Keywords: []string{"语法", "词汇", "听力", "口语", "grammar"}},
	{Slug: "exams", StrongKeywords: []string{"考试指南", "考研", "公务员考试", "资格考试", "真题", "test preparation"}, Keywords: []string{"考试", "备考", "题库", "study guide"}},
	{Slug: "science-fiction", StrongKeywords: []string{"科幻", "太空歌剧", "赛博朋克", "science fiction", "sci-fi", "cyberpunk"}, Keywords: []string{"星际", "未来世界", "scifi"}},
	{Slug: "fantasy", StrongKeywords: []string{"奇幻", "玄幻", "仙侠", "魔幻小说", "fantasy fiction"}, Keywords: []string{"魔法", "修仙", "fantasy"}},
	{Slug: "mystery", StrongKeywords: []string{"悬疑小说", "推理小说", "侦探小说", "mystery fiction", "crime fiction"}, Keywords: []string{"悬疑", "推理", "侦探", "谜案", "thriller"}},
	{Slug: "romance", StrongKeywords: []string{"言情小说", "爱情小说", "romance novel", "love story"}, Keywords: []string{"爱情", "言情", "romance"}},
	{Slug: "history", StrongKeywords: []string{"中国史", "世界史", "通史", "断代史", "历史研究"}, Keywords: []string{"历史", "史学", "考古", "history", "historical"}},
	{Slug: "biography", StrongKeywords: []string{"传记", "自传", "回忆录", "人物传", "biography", "autobiography", "memoir"}, Keywords: []string{"生平", "口述史"}},
	{Slug: "business", StrongKeywords: []string{"商业模式", "商业管理", "经济学", "business management"}, Keywords: []string{"商业", "经济", "创业", "business", "economics"}},
	{Slug: "technology", StrongKeywords: []string{"计算机技术", "信息技术", "科技史", "technology"}, Keywords: []string{"计算机", "软件", "技术", "computer", "software"}},
	{Slug: "science", StrongKeywords: []string{"自然科学", "物理学", "化学", "生物学", "天文学"}, Keywords: []string{"科学", "物理", "生物", "天文", "science", "physics", "chemistry", "biology"}},
	{Slug: "philosophy", StrongKeywords: []string{"哲学史", "伦理学", "逻辑学", "philosophy"}, Keywords: []string{"哲学", "伦理", "思想", "ethics", "logic"}},
	{Slug: "religion-spirituality", StrongKeywords: []string{"宗教学", "佛学", "基督教", "伊斯兰教", "道教", "religion and spirituality"}, Keywords: []string{"宗教", "佛教", "禅修", "灵性", "religion"}},
	{Slug: "social-sciences", StrongKeywords: []string{"社会科学", "社会学", "人类学", "sociology", "anthropology"}, Keywords: []string{"社会研究", "社会问题", "社会学"}},
	{Slug: "photography", StrongKeywords: []string{"摄影教程", "摄影作品集", "摄影艺术", "photography"}, Keywords: []string{"摄影", "相机", "拍摄"}},
	{Slug: "film-theater", StrongKeywords: []string{"电影艺术", "电影史", "戏剧艺术", "剧本集", "film studies"}, Keywords: []string{"电影", "戏剧", "剧本", "导演", "theater"}},
	{Slug: "art", StrongKeywords: []string{"艺术史", "绘画艺术", "音乐艺术", "设计艺术"}, Keywords: []string{"艺术", "绘画", "音乐", "设计", "art", "painting", "music", "design"}},
	{Slug: "children", StrongKeywords: []string{"儿童文学", "少儿读物", "童话故事", "绘本", "picture book"}, Keywords: []string{"少儿", "儿童", "童话", "children", "juvenile"}},
	{Slug: "education", StrongKeywords: []string{"教育学", "教学设计", "课程设计", "education"}, Keywords: []string{"教育", "教材", "教学", "textbook", "teaching"}},
	{Slug: "health", StrongKeywords: []string{"健康管理", "营养学", "养生保健", "health care"}, Keywords: []string{"健康", "医疗", "营养", "养生", "health", "nutrition"}},
	{Slug: "travel", StrongKeywords: []string{"旅行指南", "旅游攻略", "游记", "travel guide"}, Keywords: []string{"旅行", "旅游", "旅行文学", "travel", "guidebook"}},
	{Slug: "reference", StrongKeywords: []string{"工具书", "字典", "词典", "百科全书", "使用手册", "dictionary", "encyclopedia"}, Keywords: []string{"百科", "手册", "reference", "handbook"}},
	{Slug: "lifestyle", StrongKeywords: []string{"生活方式", "品质生活", "生活美学", "lifestyle"}, Keywords: []string{"生活", "日常", "生活指南"}},
	{Slug: "nonfiction", StrongKeywords: []string{"非虚构", "纪实文学", "nonfiction", "non-fiction"}, Keywords: []string{"纪实", "报告文学"}},
	{Slug: "literature", StrongKeywords: []string{"文学作品", "文学选集", "小说集", "literature"}, Keywords: []string{"文学", "小说", "fiction", "novel"}},
}

func Classify(book metadata.Result) []Suggestion {
	return ClassifyWithRules(book, rules)
}

func DefaultRules() []Rule {
	result := make([]Rule, 0, len(rules))
	for index, rule := range rules {
		copy := Rule{
			Slug: rule.Slug, Keywords: append([]string(nil), rule.Keywords...),
			StrongKeywords: append([]string(nil), rule.StrongKeywords...),
			Priority:       (index + 1) * 10, Version: DefaultRuleVersion,
		}
		result = append(result, copy)
	}
	return result
}

func ClassifyWithRules(book metadata.Result, configured []Rule) []Suggestion {
	if configured == nil {
		configured = rules
	}
	title := normalize(book.Title)
	description := normalize(book.Description)
	subjects := make([]string, 0, len(book.Subjects))
	for _, subject := range book.Subjects {
		subjects = append(subjects, normalize(subject))
	}

	type rankedSuggestion struct {
		Suggestion
		priority int
	}
	ranked := make([]rankedSuggestion, 0, 4)
	for index, rule := range configured {
		score, reason := scoreRule(rule, title, description, subjects)
		if score < minimumScore {
			continue
		}
		status := "suggested"
		if score >= autoAcceptThreshold {
			status = "accepted"
		}
		priority := rule.Priority
		if priority < 1 {
			priority = (index + 1) * 10
		}
		ranked = append(ranked, rankedSuggestion{Suggestion: Suggestion{
			CategorySlug: rule.Slug,
			Confidence:   score,
			Reason:       reason,
			Source:       "deterministic-rules-v2",
			Status:       status,
		}, priority: priority})
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].Confidence != ranked[j].Confidence {
			return ranked[i].Confidence > ranked[j].Confidence
		}
		if ranked[i].priority != ranked[j].priority {
			return ranked[i].priority < ranked[j].priority
		}
		return ranked[i].CategorySlug < ranked[j].CategorySlug
	})
	if len(ranked) > 3 {
		ranked = ranked[:3]
	}
	// Deterministic rules choose one primary category automatically. Other plausible
	// categories remain visible suggestions and can be approved by an administrator.
	accepted := false
	suggestions := make([]Suggestion, 0, len(ranked))
	for _, item := range ranked {
		if item.Status == "accepted" {
			if accepted {
				item.Status = "suggested"
			} else {
				accepted = true
			}
		}
		suggestions = append(suggestions, item.Suggestion)
	}
	if len(suggestions) == 0 {
		return []Suggestion{{
			CategorySlug: "other",
			Confidence:   0.35,
			Reason:       "现有书名、题材和简介没有提供足够的分类证据",
			Source:       "deterministic-rules-v2",
			Status:       "suggested",
		}}
	}
	return suggestions
}

type ruleEvidence struct {
	score   float64
	field   string
	keyword string
}

func scoreRule(rule Rule, title, description string, subjects []string) (float64, string) {
	evidence := make([]ruleEvidence, 0, 6)
	collect := func(keyword string, strong bool) {
		term := normalize(keyword)
		if term == "" {
			return
		}
		for _, subject := range subjects {
			if subject == term {
				score := 0.97
				if strong {
					score = 0.99
				}
				evidence = append(evidence, ruleEvidence{score: score, field: "题材", keyword: keyword})
				break
			}
			if containsTerm(subject, term) {
				score := 0.92
				if strong {
					score = 0.96
				}
				evidence = append(evidence, ruleEvidence{score: score, field: "题材", keyword: keyword})
				break
			}
		}
		if containsTerm(title, term) {
			score := 0.76
			if strong {
				score = 0.91
			}
			evidence = append(evidence, ruleEvidence{score: score, field: "书名", keyword: keyword})
		}
		if containsTerm(description, term) {
			score := 0.62
			if strong {
				score = 0.75
			}
			evidence = append(evidence, ruleEvidence{score: score, field: "简介", keyword: keyword})
		}
	}
	for _, keyword := range rule.StrongKeywords {
		collect(keyword, true)
	}
	for _, keyword := range rule.Keywords {
		collect(keyword, false)
	}
	if len(evidence) == 0 {
		return 0, ""
	}
	sort.SliceStable(evidence, func(i, j int) bool { return evidence[i].score > evidence[j].score })
	score := evidence[0].score
	seenFields := map[string]bool{evidence[0].field: true}
	seenKeywords := map[string]bool{normalize(evidence[0].keyword): true}
	for _, item := range evidence[1:] {
		keywordKey := normalize(item.keyword)
		if seenFields[item.field] && seenKeywords[keywordKey] {
			continue
		}
		boost := 0.04
		if !seenFields[item.field] {
			boost = 0.08
		}
		score += boost
		seenFields[item.field] = true
		seenKeywords[keywordKey] = true
		if score >= 0.99 {
			score = 0.99
			break
		}
	}
	reasons := make([]string, 0, min(3, len(evidence)))
	seenReasons := make(map[string]bool)
	for _, item := range evidence {
		reason := fmt.Sprintf("%s命中“%s”", item.field, item.keyword)
		if seenReasons[reason] {
			continue
		}
		seenReasons[reason] = true
		reasons = append(reasons, reason)
		if len(reasons) == 3 {
			break
		}
	}
	if len(reasons) > 1 {
		return score, strings.Join(reasons, "；") + "（组合证据）"
	}
	return score, reasons[0]
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
