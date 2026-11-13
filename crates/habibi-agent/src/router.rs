//! `/api/agent/route`: the configured model picks ONE known capability and
//! Habibi validates it. Ported from `src/server/services/assistant-router.ts`.
//! Execution stays in Habibi's existing UI and approved routes.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::browser_url::{
    browser_command, request_parts, requested_browser_url, requested_website_task_url, strip_wrapping,
};

/// A fixed set of user folders (`src/core/named-folders.ts`). A model never
/// supplies arbitrary filesystem paths.
pub const NAMED_FOLDERS: &[&str] =
    &["Home", "Desktop", "Documents", "Downloads", "Pictures", "Music", "Movies", "Projects", "Developer", "Code"];

const SYSTEM_ACTIONS: &[&str] = &[
    "settings",
    "applications",
    "sleep",
    "restart",
    "shutdown",
    "lock",
    "darkMode",
    "emptyTrash",
    "quitApps",
    "forceQuitApps",
];
const SEARCH_ENGINES: &[&str] = &["google", "duckduckgo", "bing", "ecosia"];

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap()
}

static REMINDER: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^(?:(?:today|tomorrow)\s+)?(?:please\s+)?(?:remind me\b|(?:create|add|set)\s+(?:a\s+)?reminder\b)")
});
static FOCUS: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(?:(?:start|set|begin)\s+(?:a\s+)?)?(?:focus|pomodoro|(?:focus\s+)?timer)\b"));
static FOCUS_MINUTES: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(?:start|set)\s+(?:a\s+)?\d+\s*(?:min(?:ute)?s?)\s+(?:focus|timer|break)\b"));
static MINUTES: LazyLock<Regex> = LazyLock::new(|| re(r"\b(\d{1,3})\s*(?:m|min(?:ute)?s?)\b"));
static CLIPBOARD: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:open|show)\s+(?:my\s+)?clipboard(?:\s+history)?$"));
static RECENTS: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(?:open|show)\s+(?:my\s+)?recent(?:ly opened)?(?:\s+(?:files|items))?$"));
static DATE: LazyLock<Regex> = LazyLock::new(|| re(r"^\d{4}-\d{2}-\d{2}$"));
static EMAIL: LazyLock<Regex> = LazyLock::new(|| re(r"^[^\s@]+@[^\s@]+\.[^\s@]+$"));
static WEBSITE_REQUEST: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b(?:website|webpage|url|domain|online|tickets?|flights?|hotels?|buses?)\b"));
static SHOPPING_REQUEST: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\b(?:search|find|buy|shop|browse)\b"));
static LOCAL_REQUEST: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b(?:local|files?|folders?|mail|email|whatsapp|calendar|notes?)\b"));
static ASKS_FOR_SITE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b(?:website|webpage|site|url|domain|address|provider|service)\b"));
static TASK_REQUEST: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b(?:tickets?|flights?|hotels?|search|find|buy|book|route)\b"));
static SAFE_OPENAI_ERROR: LazyLock<Regex> =
    LazyLock::new(|| re(r"^OpenAI (?:rejected|denied|has no available quota|model is unavailable|could not complete)"));
static SECRET_LOOKING: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)sk-|/Users/|Bearer"));
static CODE_FENCE: LazyLock<Regex> = LazyLock::new(|| re(r"^```(?:json)?\s*|\s*```$"));

/// Exact utility intents (`src/core/daily-intent.ts`) work locally, even
/// before a model has been configured. Returns the utility name.
pub fn daily_intent(value: &str) -> Option<(&'static str, Option<u32>)> {
    let text = value.trim().to_lowercase();
    if REMINDER.is_match(&text) {
        return Some(("reminders", None));
    }
    if FOCUS.is_match(&text) || FOCUS_MINUTES.is_match(&text) {
        let minutes = MINUTES
            .captures(&text)
            .and_then(|captures| captures[1].parse::<u32>().ok())
            .filter(|minutes| (1..=240).contains(minutes));
        return Some(("focus", minutes));
    }
    if CLIPBOARD.is_match(&text) {
        return Some(("clipboard", None));
    }
    if RECENTS.is_match(&text) {
        return Some(("recents", None));
    }
    None
}

/// `typeof value === 'string' ? value.trim().slice(0, limit) : ''`.
fn text(value: Option<&Value>, limit: usize) -> String {
    match value {
        Some(Value::String(value)) => value.trim().chars().take(limit).collect(),
        _ => String::new(),
    }
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        _ => 28,
    }
}

/// A real `YYYY-MM-DD` calendar date, or nothing.
fn date(value: Option<&Value>) -> Option<String> {
    let value = text(value, 10);
    if !DATE.is_match(&value) {
        return None;
    }
    let year: i64 = value[0..4].parse().ok()?;
    let month: u32 = value[5..7].parse().ok()?;
    let day: u32 = value[8..10].parse().ok()?;
    ((1..=12).contains(&month) && day >= 1 && day <= days_in_month(year, month)).then_some(value)
}

fn plan(action: &str) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("action".into(), json!(action));
    map
}

fn with(mut map: Map<String, Value>, entries: &[(&str, Value)]) -> Map<String, Value> {
    for (key, value) in entries {
        map.insert((*key).into(), value.clone());
    }
    map
}

fn clarification(question: &str) -> Map<String, Value> {
    with(plan("clarify"), &[("question", json!(question))])
}

fn default_search(query: &str) -> Map<String, Value> {
    with(
        plan("browser_search"),
        &[("provider", json!("default")), ("query", json!(query.chars().take(800).collect::<String>()))],
    )
}

fn word_pattern(word: &str) -> Regex {
    Regex::new(&format!(r"(?i)\b{}\b", regex::escape(word))).unwrap()
}

/// Validate a model's plan against the request. Anything unknown, invented
/// or unsafe becomes a clarifying question.
pub fn normalize_assistant_plan(value: &Value, request: &str) -> Map<String, Value> {
    let empty = Map::new();
    let plan_value = value.as_object().unwrap_or(&empty);
    let field = |name: &str| plan_value.get(name);
    match field("action").and_then(Value::as_str).unwrap_or("") {
        "utility" => {
            let name = text(field("name"), 500);
            if ["clipboard", "reminders", "focus", "recents"].contains(&name.as_str()) {
                with(plan("utility"), &[("name", json!(name))])
            } else {
                plan("chat")
            }
        }
        "chat" => plan("chat"),
        "clarify" => {
            let question = text(field("question"), 320);
            clarification(if question.is_empty() { "What would you like me to open or find?" } else { &question })
        }
        "open_url" => {
            let destination = field("url").and_then(Value::as_str);
            match requested_browser_url(request, destination, true)
                .or_else(|| requested_website_task_url(request, destination))
            {
                Some(url) => with(plan("open_url"), &[("url", json!(url))]),
                None => clarification("Which website address should I open?"),
            }
        }
        "browser_search" => {
            let query = text(field("query"), 800);
            if query.is_empty() {
                return clarification("What or where should I search?");
            }
            let checkin = date(field("checkin"));
            let checkout = date(field("checkout"));
            if let (Some(checkin), Some(checkout)) = (&checkin, &checkout)
                && checkout <= checkin
            {
                return clarification("What check-out date should I use after check-in?");
            }
            let selected = text(field("provider"), 500).to_lowercase();
            let named_engine = SEARCH_ENGINES.iter().find(|engine| word_pattern(engine).is_match(request));
            let provider = match named_engine {
                Some(engine) => *engine,
                None if selected == "airbnb" && word_pattern("airbnb").is_match(request) => "airbnb",
                None => "default",
            };
            let mut result = with(plan("browser_search"), &[("provider", json!(provider)), ("query", json!(query))]);
            if let Some(checkin) = checkin {
                result.insert("checkin".into(), json!(checkin));
            }
            if let Some(checkout) = checkout {
                result.insert("checkout".into(), json!(checkout));
            }
            if let Some(adults) = field("adults").and_then(Value::as_f64)
                && adults.fract() == 0.0
                && adults > 0.0
                && adults <= 30.0
            {
                result.insert("adults".into(), json!(adults as u64));
            }
            result
        }
        "provider_chat" => {
            let provider = text(field("provider"), 500).to_lowercase();
            let query = text(field("query"), 800);
            if ["chatgpt", "claude", "gemini"].contains(&provider.as_str()) && !query.is_empty() {
                with(plan("provider_chat"), &[("provider", json!(provider)), ("query", json!(query))])
            } else {
                clarification("Which assistant and request should I open?")
            }
        }
        "open_folder" => {
            let requested = text(field("folder"), 500).to_lowercase();
            match NAMED_FOLDERS.iter().find(|name| name.to_lowercase() == requested) {
                Some(folder) => with(plan("open_folder"), &[("folder", json!(folder))]),
                None => clarification(&format!("Which folder should I open: {}?", NAMED_FOLDERS.join(", "))),
            }
        }
        "open_app" => {
            let app = text(field("app"), 160);
            if app.is_empty() {
                clarification("Which application should I open?")
            } else {
                with(plan("open_app"), &[("app", json!(app))])
            }
        }
        "local_files" => plan("local_files"),
        "mail" => {
            let recipient = text(field("to"), 200);
            // A model may not invent an address the user never typed.
            let to = if EMAIL.is_match(&recipient) && request.to_lowercase().contains(&recipient.to_lowercase()) {
                recipient
            } else {
                String::new()
            };
            let mode = match field("mode").and_then(Value::as_str) {
                Some("compose") => "compose",
                Some("search") => "search",
                _ => "inbox",
            };
            with(
                plan("mail"),
                &[
                    ("mode", json!(mode)),
                    ("query", json!(text(field("query"), 500))),
                    ("to", json!(to)),
                    ("subject", json!(text(field("subject"), 300))),
                    ("body", json!(text(field("body"), 8000))),
                ],
            )
        }
        "whatsapp" => {
            let mode = match field("mode").and_then(Value::as_str) {
                Some("message") => "message",
                Some("search") => "search",
                _ => "chats",
            };
            let target = text(field("target"), 200);
            if mode == "message" && target.is_empty() {
                return clarification("Who should I prepare the WhatsApp message for?");
            }
            with(
                plan("whatsapp"),
                &[
                    ("mode", json!(mode)),
                    ("target", json!(target)),
                    ("instruction", json!(text(field("instruction"), 2000))),
                ],
            )
        }
        "calendar" => {
            let mode = if field("mode").and_then(Value::as_str) == Some("draft") { "draft" } else { "upcoming" };
            with(plan("calendar"), &[("mode", json!(mode))])
        }
        "whodb" => with(plan("whodb"), &[("question", json!(text(field("question"), 2000)))]),
        "kubernetes" => {
            let query = text(field("query"), 2000);
            with(plan("kubernetes"), &[("query", json!(if query.is_empty() { request.to_string() } else { query }))])
        }
        "system" => {
            let name = text(field("name"), 500);
            if SYSTEM_ACTIONS.contains(&name.as_str()) {
                with(plan("system"), &[("name", json!(name))])
            } else {
                clarification("Which macOS action would you like?")
            }
        }
        _ => clarification("What would you like me to open, find, or prepare?"),
    }
}

fn website_fallback(plan: Map<String, Value>, request: &str) -> Map<String, Value> {
    // A typed URL or domain is the user's exact destination, even inside prose.
    if request_parts(request).into_iter().any(|part| browser_command(&strip_wrapping(part)).is_some()) {
        return plan;
    }
    let website_request =
        WEBSITE_REQUEST.is_match(request) || (SHOPPING_REQUEST.is_match(request) && !LOCAL_REQUEST.is_match(request));
    if !website_request {
        return plan;
    }
    let action = plan.get("action").and_then(Value::as_str).unwrap_or("");
    if action == "clarify"
        && plan.get("question").and_then(Value::as_str).is_some_and(|question| ASKS_FOR_SITE.is_match(question))
    {
        return default_search(request);
    }
    // A homepage drops the route, product, or search terms from a specific task.
    if action == "open_url"
        && TASK_REQUEST.is_match(request)
        && let Some(url) = plan.get("url").and_then(Value::as_str).and_then(|url| url::Url::parse(url).ok())
        && url.path() == "/"
        && url.query().is_none_or(str::is_empty)
    {
        return default_search(request);
    }
    plan
}

/// The routing system prompt, with `today` as `YYYY-MM-DD` in local time.
pub fn assistant_routing_prompt(today: &str) -> String {
    let folders = NAMED_FOLDERS.join(", ");
    let actions = SYSTEM_ACTIONS.join("|");
    format!(
        r#"You are Habibi, a local-first macOS assistant. Choose the capability that best fulfills the user's CURRENT request. Return ONE JSON action and its arguments, without Markdown. Context helps resolve follow-ups, but never carry an old task into an unrelated new request. Today is {today} in the user's local timezone.
Capabilities and argument shapes:
- {{"action":"open_url","url":"https://..."}}: open an explicit URL, the official homepage of a named website, or a task-specific page when you know the official domain and URL format confidently. For a trip or product search, carry the supplied places, dates, and search terms into the destination; never invent missing values. Preserve literal user URLs exactly, including paths and query parameters. If a task page cannot be formed confidently, use browser_search with the default provider. Never search LOCAL FILES for a website.
- {{"action":"open_folder","folder":"..."}}: open one of {folders}. "open downloads" opens the Downloads folder; it is not a filename search. Never return arbitrary paths or shell commands.
- {{"action":"open_app","app":"application name"}}: launch an installed application. Habibi resolves it locally.
- {{"action":"local_files"}}: search for an actual local file/document/image, filename, or a file-request follow-up. Use only when the user wants local files. "open a company's website" is NOT local_files.
- {{"action":"browser_search","provider":"default"|"airbnb"|"google"|"duckduckgo"|"bing"|"ecosia","query":"destination or search query","checkin":"YYYY-MM-DD or omit","checkout":"YYYY-MM-DD or omit","adults":number or omit}}: open real search results. Use Airbnb when requested. Use default for ordinary web searches and uncertain website or provider-specific routes; include the brand, origin, destination, dates, and other user terms in the query. Use a named search engine only when the user explicitly requested it. Do not ask for a website address when a web search can find it. Preserve dates and guest count for Airbnb. Relative dates must be resolved from today. Do not claim to have searched, found listings, booked, or paid.
- {{"action":"mail","mode":"inbox"|"search"|"compose","query":"mail filter if searching","to":"recipient email if supplied","subject":"draft subject","body":"draft message"}}: open connected Mail, search sender/subject/content metadata, or prepare an editable email. Never send. Missing recipient details stay blank for the user to fill in. Do not invent addresses.
- {{"action":"whatsapp","mode":"chats"|"search"|"message","target":"contact name or chat query","instruction":"message drafting instructions"}}: open linked WhatsApp, find a chat, or prepare a message for review. Contacts are resolved locally; never invent contact details or send messages.
- {{"action":"calendar","mode":"upcoming"|"draft"}}: show upcoming events or prepare an editable event from the user's request. Never create an event without the existing approval step.
- {{"action":"whodb","question":"question about the user's WhoDB data, or empty for opening"}}: open WhoDB and run read-only questions. General questions ABOUT the product WhoDB are chat, not data queries.
- {{"action":"kubernetes","query":"the investigation request"}}: open the existing Kubernetes investigation capability.
- {{"action":"system","name":"{actions}"}}: open the existing macOS action UI. Destructive actions retain their confirmation; this action never grants approval.
- {{"action":"provider_chat","provider":"chatgpt"|"claude"|"gemini","query":"request"}}: only when explicitly asked to use another assistant in the browser.
- {{"action":"clarify","question":"one concise question"}}: only for a genuinely missing detail needed to choose a destination or capability.
- {{"action":"utility","name":"clipboard|reminders|focus|recents"}}: open clipboard history, review an Apple Reminder, open a focus timer, or browse recent local files. Never claim a reminder was saved.
- {{"action":"chat"}}: answer ordinary questions, explanations, writing, or conversation in Habibi.
You are planning, not executing. Every selected capability requires explicit user confirmation before execution, including reads, opening apps, and searches. Never grant approval yourself. Never say an action already happened. Never invent file contents, inbox results, contacts, web results, permissions, bookings, or authentication. No capability accepts arbitrary code. Do not route websites, Mail, WhatsApp, or travel requests to local files."#
    )
}

/// What the router needs from the model: one completion.
pub struct RouterCompletion {
    pub ok: bool,
    pub text: Option<String>,
    pub error: Option<String>,
    pub needs_configuration: bool,
}

/// `route({ text, context })`. `complete` receives `(user_text, system_prompt)`.
pub async fn route<F, Fut>(request_text: &str, context: &str, today: &str, complete: F) -> Value
where
    F: FnOnce(String, String) -> Fut,
    Fut: std::future::Future<Output = RouterCompletion>,
{
    let request: String = request_text.trim().chars().take(4000).collect();
    if request.is_empty() {
        return json!({ "ok": true, "action": "chat" });
    }
    if let Some((name, _)) = daily_intent(&request) {
        return json!({ "ok": true, "action": "utility", "name": name });
    }
    let context: String = context.trim().chars().take(2000).collect();
    let result =
        complete(format!("Prior user request: {context}\nCurrent request: {request}"), assistant_routing_prompt(today))
            .await;
    if !result.ok {
        let safe_error: String = result.error.as_deref().unwrap_or("").trim().chars().take(300).collect();
        let error = if SAFE_OPENAI_ERROR.is_match(&safe_error) && !SECRET_LOOKING.is_match(&safe_error) {
            safe_error
        } else {
            "The configured model could not plan this action. Check Model settings and try again.".into()
        };
        let mut response = json!({ "ok": false, "action": "chat", "error": error });
        if result.needs_configuration {
            response["needsConfiguration"] = json!(true);
        }
        return response;
    }
    let raw = result.text.unwrap_or_default();
    let cleaned = CODE_FENCE.replace_all(&raw, "");
    match serde_json::from_str::<Value>(cleaned.trim()) {
        Ok(value) => {
            let mut plan = website_fallback(normalize_assistant_plan(&value, &request), &request);
            plan.insert("ok".into(), json!(true));
            Value::Object(plan)
        }
        Err(_) => {
            json!({ "ok": false, "action": "chat", "error": "Habibi could not interpret the model’s action. Please try again." })
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    fn completion(text: Value) -> RouterCompletion {
        RouterCompletion { ok: true, text: Some(text.to_string()), error: None, needs_configuration: false }
    }

    async fn route_with(request: &str, reply: Value) -> Value {
        route(request, "", "2026-11-12", |_, _| async move { completion(reply) }).await
    }

    fn normalize(value: Value, request: &str) -> Value {
        Value::Object(normalize_assistant_plan(&value, request))
    }

    #[tokio::test]
    async fn the_capability_router_supports_every_capability() {
        let cases = [
            ("open clidey website", json!({ "action": "open_url", "url": "https://clidey.com/" })),
            ("open downloads", json!({ "action": "open_folder", "folder": "Downloads" })),
            ("launch Safari", json!({ "action": "open_app", "app": "Safari" })),
            ("Find the local project brief PDF", json!({ "action": "local_files" })),
            (
                "search Airbnb in Paris for two adults",
                json!({ "action": "browser_search", "provider": "airbnb", "query": "Paris", "adults": 2 }),
            ),
            ("search my mail for invoices", json!({ "action": "mail", "mode": "search", "query": "invoices" })),
            (
                "prepare an email to maya@example.test",
                json!({ "action": "mail", "mode": "compose", "to": "maya@example.test", "subject": "Demo", "body": "See you Monday." }),
            ),
            ("open WhatsApp", json!({ "action": "whatsapp", "mode": "chats" })),
            (
                "message Maya on WhatsApp saying hello",
                json!({ "action": "whatsapp", "mode": "message", "target": "Maya", "instruction": "Say hello" }),
            ),
            ("show my upcoming meetings", json!({ "action": "calendar", "mode": "upcoming" })),
            ("schedule lunch tomorrow at 1pm", json!({ "action": "calendar", "mode": "draft" })),
            ("ask WhoDB about late orders", json!({ "action": "whodb", "question": "Which orders shipped late?" })),
            ("show production pods", json!({ "action": "kubernetes", "query": "show production pods" })),
            ("open system settings", json!({ "action": "system", "name": "settings" })),
            ("what is WhoDB?", json!({ "action": "chat" })),
        ];
        for (request, plan) in cases {
            let calls = Mutex::new(Vec::new());
            let reply = plan.clone();
            let result = route(request, "Previously I was finding local files.", "2026-11-12", |user, system| {
                calls.lock().unwrap().push((user, system));
                async move { completion(reply) }
            })
            .await;
            assert_eq!(result["ok"], true, "{request}: {result}");
            assert_eq!(result["action"], plan["action"], "{request}: {result}");
            let calls = calls.into_inner().unwrap();
            assert_eq!(calls.len(), 1);
            assert!(calls[0].0.contains(request));
            assert!(calls[0].1.to_lowercase().contains("never carry an old task"));
        }
    }

    #[tokio::test]
    async fn router_failures_remain_errors_rather_than_pretending_to_find_local_files() {
        let failed = route("open clidey website", "", "2026-11-12", |_, _| async {
            RouterCompletion {
                ok: false,
                text: None,
                error: Some(
                    "OpenAI rejected the saved API key. Paste the complete key again in Model settings.".into(),
                ),
                needs_configuration: false,
            }
        })
        .await;
        assert_eq!(failed["ok"], false);
        assert!(failed["error"].as_str().unwrap().contains("OpenAI rejected"));
        assert_ne!(failed["action"], "local_files");
        let malformed = route("open downloads", "", "2026-11-12", |_, _| async {
            RouterCompletion { ok: true, text: Some("not json".into()), error: None, needs_configuration: false }
        })
        .await;
        assert_eq!(malformed["ok"], false);
        let leaky = route("open downloads", "", "2026-11-12", |_, _| async {
            RouterCompletion {
                ok: false,
                text: None,
                error: Some("OpenAI rejected sk-123".into()),
                needs_configuration: false,
            }
        })
        .await;
        assert_eq!(
            leaky["error"],
            "The configured model could not plan this action. Check Model settings and try again."
        );
    }

    #[tokio::test]
    async fn utilities_and_empty_requests_never_call_the_model() {
        let never = |_: String, _: String| async { panic!("the model should not be called") };
        assert_eq!(route("  ", "", "2026-11-12", never).await, json!({ "ok": true, "action": "chat" }));
        assert_eq!(
            route("open clipboard history", "", "2026-11-12", never).await,
            json!({ "ok": true, "action": "utility", "name": "clipboard" })
        );
        assert_eq!(daily_intent("start a 25 min focus"), Some(("focus", Some(25))));
        assert_eq!(daily_intent("remind me to call mum"), Some(("reminders", None)));
        assert_eq!(daily_intent("show recent files"), Some(("recents", None)));
    }

    #[tokio::test]
    async fn a_named_website_can_open_a_task_page_when_its_site_and_terms_match_the_request() {
        assert_eq!(
            route_with(
                "redbus bus tickets from Delhi to Dehradun",
                json!({ "action": "open_url", "url": "https://www.redbus.in/bus-tickets/delhi-to-dehradun" })
            )
            .await,
            json!({ "ok": true, "action": "open_url", "url": "https://www.redbus.in/bus-tickets/delhi-to-dehradun" })
        );
        assert_eq!(
            normalize(
                json!({ "action": "open_url", "url": "https://www.amazon.com/s?k=headphones" }),
                "search Amazon for headphones"
            ),
            json!({ "action": "open_url", "url": "https://www.amazon.com/s?k=headphones" })
        );
        assert_eq!(
            normalize(
                json!({ "action": "open_url", "url": "https://www.etsy.com/search?q=ceramic+mug" }),
                "search Etsy for ceramic mug"
            ),
            json!({ "action": "open_url", "url": "https://www.etsy.com/search?q=ceramic+mug" })
        );
        assert_eq!(
            normalize(
                json!({ "action": "open_url", "url": "https://www.amazon.com/s?k=iphone" }),
                "search Amazon for iPhone 16 Pro Max"
            )["action"],
            "clarify"
        );
        assert_eq!(
            normalize(
                json!({ "action": "open_url", "url": "https://redbus.evil.com/bus-tickets/delhi-to-dehradun" }),
                "redbus bus tickets from Delhi to Dehradun"
            )["action"],
            "clarify"
        );
        assert_eq!(
            normalize(
                json!({ "action": "open_url", "url": "https://www.redbus.in/checkout?from=Delhi&to=Dehradun" }),
                "redbus bus tickets from Delhi to Dehradun"
            )["action"],
            "clarify"
        );
    }

    #[tokio::test]
    async fn uncertain_website_destinations_use_the_default_search_provider_with_request_details_intact() {
        let request = "redbus bus tickets from Delhi to Dehradun tomorrow";
        assert_eq!(
            route_with(request, json!({ "action": "open_url", "url": "https://www.redbus.in/bus-tickets/delhi-to-dehradun?onward=guessed" })).await,
            json!({ "ok": true, "action": "browser_search", "provider": "default", "query": request })
        );
        assert_eq!(
            route_with(
                "bus tickets online from Delhi to Dehradun",
                json!({ "action": "clarify", "question": "Which website address should I open?" })
            )
            .await,
            json!({ "ok": true, "action": "browser_search", "provider": "default", "query": "bus tickets online from Delhi to Dehradun" })
        );
        assert_eq!(
            route_with(
                "open redbus tickets from Delhi to Dehradun for tomorrow",
                json!({ "action": "open_url", "url": "https://www.redbus.in/" })
            )
            .await,
            json!({ "ok": true, "action": "browser_search", "provider": "default", "query": "open redbus tickets from Delhi to Dehradun for tomorrow" })
        );
    }

    #[tokio::test]
    async fn an_explicit_url_is_never_replaced_with_a_web_search() {
        let reply = json!({ "action": "open_url", "url": "https://other.example/" });
        assert_eq!(route_with("Open https://clidey.com/", reply.clone()).await["action"], "clarify");
        assert_eq!(route_with("Open clidey.com website", reply).await["action"], "clarify");
        assert_eq!(
            route_with("Open https://clidey.com/", json!({ "action": "open_url", "url": "https://clidey.com/" })).await,
            json!({ "ok": true, "action": "open_url", "url": "https://clidey.com/" })
        );
    }

    #[test]
    fn a_named_search_engine_overrides_the_saved_default_only_when_the_user_requests_it() {
        let plan = |provider: &str| json!({ "action": "browser_search", "provider": provider, "query": "weather" });
        assert_eq!(normalize(plan("google"), "find weather online")["provider"], "default");
        assert_eq!(normalize(plan("duckduckgo"), "search DuckDuckGo for weather")["provider"], "duckduckgo");
        assert_eq!(normalize(plan("bing"), "search Bing for weather")["provider"], "bing");
    }

    #[test]
    fn plans_reject_invented_url_replacements_paths_unknown_tools_and_destructive_code() {
        for value in [
            json!({ "action": "open_url", "url": "javascript:alert(1)" }),
            json!({ "action": "open_url", "url": "file:///etc/passwd" }),
            json!({ "action": "open_url", "url": "https://other.example/" }),
            json!({ "action": "open_folder", "folder": "../../etc" }),
            json!({ "action": "system", "name": "run shell" }),
            json!({ "action": "exec", "command": "rm -rf" }),
        ] {
            assert_eq!(normalize(value.clone(), "open https://clidey.com/")["action"], "clarify", "{value}");
        }
        assert_eq!(
            normalize(
                json!({ "action": "open_url", "url": "https://clidey.com/delete?confirm=1" }),
                "open clidey website"
            )["action"],
            "clarify"
        );
        assert_eq!(
            normalize(json!({ "action": "open_url", "url": "https://127.0.0.1/" }), "open clidey website")["action"],
            "clarify"
        );
        assert_eq!(
            normalize(json!({ "action": "open_url", "url": "https://admin.localhost/" }), "open clidey website")["action"],
            "clarify"
        );
        let draft = normalize(
            json!({ "action": "mail", "mode": "compose", "to": "invented@example.test", "body": "Hello" }),
            "draft a message to Maya",
        );
        assert_eq!(draft["to"], "");
        assert_eq!(draft["mode"], "compose");
    }

    #[test]
    fn airbnb_preserves_valid_dates_and_guests_and_clarifies_invalid_date_order() {
        let valid = json!({ "action": "browser_search", "provider": "airbnb", "query": "Lisbon", "checkin": "2026-11-06", "checkout": "2026-11-09", "adults": 2 });
        assert_eq!(normalize(valid.clone(), "Airbnb Lisbon"), valid);
        let mut reversed = valid.clone();
        reversed["checkout"] = json!("2026-11-05");
        assert_eq!(normalize(reversed, "Airbnb Lisbon")["action"], "clarify");
        let mut impossible = valid;
        impossible["checkin"] = json!("2026-02-30");
        assert!(normalize(impossible, "Airbnb Lisbon").get("checkin").is_none());
        assert!(assistant_routing_prompt("2026-10-29").contains("Today is 2026-10-29"));
    }

    #[tokio::test]
    async fn fenced_json_and_configuration_errors_are_handled() {
        let fenced = route("launch Safari", "", "2026-11-12", |_, _| async {
            RouterCompletion {
                ok: true,
                text: Some("```json\n{\"action\":\"open_app\",\"app\":\"Safari\"}\n```".into()),
                error: None,
                needs_configuration: false,
            }
        })
        .await;
        assert_eq!(fenced, json!({ "ok": true, "action": "open_app", "app": "Safari" }));
        let unconfigured = route("launch Safari", "", "2026-11-12", |_, _| async {
            RouterCompletion {
                ok: false,
                text: None,
                error: Some("Choose a model provider first.".into()),
                needs_configuration: true,
            }
        })
        .await;
        assert_eq!(unconfigured["needsConfiguration"], true);
    }
}
