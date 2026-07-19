ALTER TABLE categories
    ADD COLUMN system BOOLEAN NOT NULL DEFAULT false;

UPDATE categories SET system=true;

INSERT INTO categories(slug,name,system) VALUES
    ('nonfiction','综合非虚构',true),
    ('lifestyle','生活方式',true),
    ('religion-spirituality','宗教与心灵',true),
    ('classics','经典名著',true),
    ('contemporary-fiction','当代小说',true),
    ('historical-fiction','历史小说',true),
    ('horror','恐怖惊悚',true),
    ('humor','幽默',true),
    ('poetry','诗歌',true),
    ('essays','散文随笔',true),
    ('true-crime','纪实犯罪',true),
    ('comics','漫画与图像小说',true),
    ('photography','摄影',true),
    ('film-theater','影视与戏剧',true),
    ('psychology','心理学',true),
    ('politics-law','政治与法律',true),
    ('military','军事',true),
    ('management','管理',true),
    ('finance-investment','金融与投资',true),
    ('marketing','市场营销',true),
    ('programming','编程开发',true),
    ('ai-data','人工智能与数据',true),
    ('cybersecurity','网络与安全',true),
    ('engineering','工程技术',true),
    ('mathematics','数学',true),
    ('earth-environment','地球与环境',true),
    ('medicine','医学',true),
    ('sports-fitness','运动与健身',true),
    ('self-help','个人成长',true),
    ('cooking-food','烹饪与饮食',true),
    ('parenting-family','亲子与家庭',true),
    ('home-gardening','家居与园艺',true),
    ('crafts-hobbies','手工与爱好',true),
    ('language-learning','语言学习',true),
    ('exams','考试与资格',true)
ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,system=true;

UPDATE categories child SET parent_id=parent.id
FROM categories parent
WHERE (child.slug,parent.slug) IN (
    ('science-fiction','literature'),('fantasy','literature'),('mystery','literature'),('romance','literature'),
    ('classics','literature'),('contemporary-fiction','literature'),('historical-fiction','literature'),
    ('horror','literature'),('humor','literature'),('poetry','literature'),('essays','literature'),
    ('true-crime','mystery'),
    ('biography','nonfiction'),('military','history'),
    ('psychology','social-sciences'),('politics-law','social-sciences'),
    ('management','business'),('finance-investment','business'),('marketing','business'),
    ('programming','technology'),('ai-data','technology'),('cybersecurity','technology'),('engineering','technology'),
    ('mathematics','science'),('earth-environment','science'),
    ('comics','art'),('photography','art'),('film-theater','art'),
    ('medicine','health'),('sports-fitness','health'),
    ('language-learning','education'),('exams','education'),
    ('self-help','lifestyle'),('cooking-food','lifestyle'),('parenting-family','lifestyle'),
    ('home-gardening','lifestyle'),('crafts-hobbies','lifestyle')
);

CREATE INDEX categories_parent_active_idx ON categories(parent_id,active,name);

