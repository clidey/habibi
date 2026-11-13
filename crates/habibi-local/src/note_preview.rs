//! Launcher previews for notes: readable prose and structural labels, never
//! Markdown table cells or delimiters. Ported from `src/core/note-preview.ts`
//! (which used marked's lexer; this walks pulldown-cmark events instead).

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

use crate::util::{collapse_whitespace, utf16_slice};

fn strip_tags(value: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in value.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// One top-level block's text: inline pieces joined by spaces.
#[derive(Default)]
struct Block {
    parts: Vec<String>,
    /// Merge consecutive text events into one piece.
    open_text: bool,
}

impl Block {
    fn text(&mut self, value: &str) {
        if self.open_text
            && let Some(last) = self.parts.last_mut()
        {
            last.push_str(value);
            return;
        }
        self.parts.push(value.to_string());
        self.open_text = true;
    }

    fn label(&mut self, value: &str) {
        self.parts.push(value.to_string());
        self.open_text = false;
    }

    fn boundary(&mut self) {
        self.open_text = false;
    }

    fn finish(self) -> String {
        let joined = self
            .parts
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        collapse_whitespace(&joined).trim().to_string()
    }
}

pub fn note_preview(body: &str) -> String {
    let source = utf16_slice(body, 6000);
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    let mut blocks: Vec<String> = Vec::new();
    let mut current = Block::default();
    let mut depth = 0usize;
    // Inside a table, code block or image the content is replaced by a label.
    let mut hidden = 0usize;
    let mut image_alt: Option<String> = None;
    for event in Parser::new_ext(&source, options) {
        match event {
            Event::Start(tag) => {
                depth += 1;
                match tag {
                    Tag::Table(_) => {
                        if hidden == 0 {
                            current.label("Table");
                        }
                        hidden += 1;
                    }
                    Tag::CodeBlock(_) => {
                        if hidden == 0 {
                            current.label("Code block");
                        }
                        hidden += 1;
                    }
                    Tag::Image { .. } => {
                        if hidden == 0 {
                            image_alt = Some(String::new());
                        }
                        hidden += 1;
                    }
                    _ => current.boundary(),
                }
            }
            Event::End(end) => {
                depth = depth.saturating_sub(1);
                match end {
                    TagEnd::Table | TagEnd::CodeBlock => hidden = hidden.saturating_sub(1),
                    TagEnd::Image => {
                        hidden = hidden.saturating_sub(1);
                        if hidden == 0
                            && let Some(alt) = image_alt.take()
                        {
                            current.label(if alt.is_empty() { "Image" } else { &alt });
                        }
                    }
                    _ => current.boundary(),
                }
                if depth == 0 {
                    blocks.push(std::mem::take(&mut current).finish());
                }
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some(alt) = image_alt.as_mut() {
                    alt.push_str(&text);
                } else if hidden == 0 {
                    current.text(&text);
                }
            }
            Event::Html(html) | Event::InlineHtml(html) if hidden == 0 => {
                current.text(&strip_tags(&html));
                if depth == 0 {
                    blocks.push(std::mem::take(&mut current).finish());
                }
            }
            Event::SoftBreak | Event::HardBreak if hidden == 0 => current.text(" "),
            _ => {}
        }
    }
    let joined = blocks
        .into_iter()
        .filter(|block| !block.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let preview = utf16_slice(&joined, 110);
    if preview.is_empty() {
        "Empty note".into()
    } else {
        preview
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_show_prose_and_labels_not_table_cells() {
        let table = "| Private name | Amount |\n| :--- | ---: |\n| Internal value | 99 |";
        assert_eq!(
            note_preview(&format!("A short introduction\n\n{table}")),
            "A short introduction · Table"
        );
        assert_eq!(
            note_preview("**Plan** with [the team](https://example.com)\n\n- First task"),
            "Plan with the team · First task"
        );
        assert_eq!(
            note_preview("# Title\n\n```\nsecret()\n```\n\n![diagram](x.png)"),
            "Title · Code block · diagram"
        );
        assert_eq!(note_preview(""), "Empty note");
        assert_eq!(note_preview("---"), "Empty note");
        assert_eq!(note_preview("<b>bold</b> text"), "bold text");
    }
}
