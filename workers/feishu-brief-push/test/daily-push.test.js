import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const date = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const base = "https://brief.example";
const legacyPublisher = ["星期一", "研究室"].join("");
const sectionNames = ["AI 产品前线", "AI 行业现场", "AI 资本与牌局", "AI 能力底座"];

function makeSections() {
  return sectionNames.map((name, section) => ({
    name,
    subtitle: `Section ${section + 1}`,
    items: Array.from({ length: 3 }, (_, item) => ({
      title: `动态 ${section + 1}-${item + 1}`,
      description: `动态正文 ${section + 1}-${item + 1}`,
      sourceName: "官方来源",
      sourceUrl: `https://source.example/${section + 1}/${item + 1}`,
      sourceDateLabel: date,
    })),
  }));
}

function fixture(t, { ready = true, issueDate = date, reject = false, sections = makeSections() } = {}) {
  const values = new Map();
  const cards = [];
  const env = {
    SITE_BASE_URL: base,
    MANUAL_TRIGGER_TOKEN: "test-trigger",
    FEISHU_APP_ID: "test-app",
    FEISHU_APP_SECRET: "test-secret",
    FEISHU_CHAT_ID: "test-chat",
    BRIEF_PUSH_STATE: {
      get: async (key) => values.get(key),
      put: async (key, data) => values.set(key, JSON.parse(data)),
    },
  };
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === `${base}/briefs/${date}.html`) {
      assert.equal(options.method, "HEAD");
      return new Response(null, { status: ready ? 200 : 404 });
    }
    if (url === `${base}/brief-data/${date}.json`) {
      return Response.json({
        date: issueDate, opening: `${legacyPublisher}发布今日简报。`,
        homepage: { headline: "今日行业动态" }, insight: "MondayLab 观察。",
        sections,
      });
    }
    if (url === "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal") {
      return Response.json({ code: 0, tenant_access_token: "test-tenant" });
    }
    if (url === "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id") {
      const message = JSON.parse(options.body);
      assert.equal(message.msg_type, "interactive");
      assert.equal(message.receive_id, "test-chat");
      cards.push(JSON.parse(message.content));
      if (reject) return Response.json({ code: 1 });
      return Response.json({ code: 0, data: { message_id: "test-message" } });
    }
    assert.fail(`Unexpected request: ${url}`);
  });
  return {
    cards, values, fetchMock,
    async run(path = "/send", query = `date=${date}`, token = "test-trigger") {
      return worker.fetch(new Request(`https://worker.example${path}?${query}`, {
        headers: { authorization: `Bearer ${token}` },
      }), env);
    },
    async scheduled() {
      let push;
      await worker.scheduled({ cron: "40 22 * * *" }, env, { waitUntil: (work) => { push = work; } });
      return push;
    },
  };
}

test("scheduled push sends four stacked sections with individually collapsed items", async (t) => {
  const f = fixture(t);
  assert.equal((await f.scheduled()).deliveryMode, "text_card");
  const [card] = f.cards;
  assert.equal(card.schema, "2.0");
  assert.equal(card.config.width_mode, "default");
  assert.equal(card.header.subtitle.content, "坐标原点研究室");
  assert.equal(card.header.template, "blue");
  const elements = card.body.elements;
  assert.deepEqual(elements.map(({ tag }) => tag), [
    "column_set", "column_set", "column_set", "column_set", "button",
  ]);
  const modules = elements.slice(0, -1).map(({ columns }) => {
    assert.equal(columns.length, 1);
    return columns[0];
  });
  for (const [index, section] of makeSections().entries()) {
    const panel = modules[index];
    assert.equal(panel.padding, "12px");
    assert.ok(card.config.style.color[panel.background_style].light_mode);
    assert.ok(card.config.style.color[panel.background_style].dark_mode);
    const [header, ...items] = panel.elements;
    assert.equal(header.content, `<text_tag color='blue'>0${index + 1}</text_tag> **${section.name}**`);
    assert.equal(items.length, 3);
    for (const [itemIndex, item] of section.items.entries()) {
      const url = `${base}/reader.html?date=${date}#brief-item-${index + 1}-${itemIndex + 1}`;
      const panel = items[itemIndex];
      assert.equal(panel.tag, "collapsible_panel");
      assert.equal(panel.expanded, false);
      assert.match(panel.header.title.content, /查看详情/);
      assert.ok(panel.header.title.content.startsWith("**" + item.title.replace("-", "\\-") + "**"));
      assert.doesNotMatch(JSON.stringify(panel.header), /动态正文|官方来源|source\.example|\d{4}-\d{2}-\d{2}/);
      assert.equal(panel.header.icon_position, "right");
      assert.equal(panel.header.icon_expanded_angle, 180);
      assert.equal(panel.elements[0].content, item.description.replace("-", "\\-"));
      assert.ok(panel.elements[1].content.includes("[官方来源](" + item.sourceUrl + ")"));
      assert.ok(panel.elements[1].content.includes(date.replaceAll("-", "\\-")));
      assert.ok(panel.elements[1].content.includes("[报刊条目](" + url + ")"));
    }
  }
  assert.ok(!JSON.stringify(card).includes(legacyPublisher));
  assert.doesNotMatch(JSON.stringify(card), /今日行业动态|今日洞察|MondayLab|img_key/);
  assert.equal(elements.at(-1).text.content, "阅读完整报刊");
  assert.equal(elements.at(-1).behaviors[0].default_url, `${base}/reader.html?date=${date}`);
  assert.equal(f.values.get(`brief-push:${date}`).messageId, "test-message");
  for (const path of ["/send", "/send-link"]) {
    assert.equal((await (await f.run(path)).json()).reason, "already_sent");
  }
  assert.equal(f.cards.length, 1);
  assert.equal(f.fetchMock.mock.callCount(), 4);
});

test("manual push sends without screenshot credentials and rejects unauthorized or invalid requests", async (t) => {
  const f = fixture(t);
  assert.equal((await f.run("/send", `date=${date}`, "invalid")).status, 401);
  assert.equal((await f.run("/send", "date=bad")).status, 400);
  assert.equal((await f.run("/send-image-url")).status, 404);
  assert.equal(f.fetchMock.mock.callCount(), 0);
  assert.equal((await (await f.run()).json()).deliveryMode, "text_card");
});

test("unpublished issue is recorded for retry without contacting Feishu", async (t) => {
  const f = fixture(t, { ready: false });
  assert.equal((await f.scheduled()).reason, "page_not_ready");
  assert.equal(f.values.get(`brief-push:${date}`).status, "waiting_for_page");
  assert.equal(f.fetchMock.mock.callCount(), 2);
});

test("mismatched issue data is not sent", async (t) => {
  const f = fixture(t, { issueDate: "2000-01-01" });
  assert.equal((await (await f.run()).json()).reason, "page_not_ready");
  assert.equal(f.cards.length, 0);
});

test("an incomplete issue is retried rather than sending fewer than twelve items", async (t) => {
  const sections = makeSections();
  sections[2].items.pop();
  const f = fixture(t, { sections });
  assert.equal((await (await f.run()).json()).reason, "page_not_ready");
  assert.equal(f.values.get(`brief-push:${date}`).status, "waiting_for_page");
  assert.equal(f.cards.length, 0);
});

test("folded details preserve source dates, escape markup and reject unsafe source URLs", async (t) => {
  const sections = makeSections();
  sections[0].items[0].title = "标题 [测试]\n<at id=all>";
  sections[0].items[0].description = "MondayLab 的原文 <script>";
  sections[0].items[0].sourceDateLabel = "2026-06 · 最近官方参考";
  sections[0].items[0].sourceUrl = "https://source.example/article(a)";
  sections[0].items[1].sourceDateLabel = null;
  sections[0].items[1].sourceUrl = "javascript:alert(1)";
  sections[0].items[2].sourceName = null;
  sections[0].items[2].sourceUrl = "https://source.example/unnamed";
  const f = fixture(t, { sections });
  assert.equal((await (await f.run()).json()).deliveryMode, "text_card");
  const [, monthly, undated, unnamed] = f.cards[0].body.elements[0].columns[0].elements;
  assert.ok(monthly.header.title.content.startsWith("**标题 \\[测试\\] &lt;at"));
  assert.doesNotMatch(monthly.header.title.content, /<at|最近官方参考|\n/);
  assert.match(monthly.elements[0].content, /坐标原点研究室.*&lt;script/);
  assert.ok(monthly.elements[1].content.includes("2026\\-06 · 最近官方参考"));
  assert.match(monthly.elements[1].content, /article%28a%29/);
  assert.doesNotMatch(undated.elements[1].content, /<font|javascript:/);
  assert.ok(undated.elements[1].content.startsWith("官方来源 · "));
  assert.ok(unnamed.elements[1].content.startsWith("[原文](https://source.example/unnamed)"));
});

test("Feishu rejection is recorded as failed and does not trigger an image fallback", async (t) => {
  const f = fixture(t, { reject: true });
  assert.equal((await f.run()).status, 500);
  assert.equal(f.values.get(`brief-push:${date}`).status, "failed");
  assert.equal(f.fetchMock.mock.callCount(), 4);
});
