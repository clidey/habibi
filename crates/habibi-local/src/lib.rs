//! OS-facing routes and local data: apps, files, folders, URLs, system
//! actions, running apps, previews, agent sessions, the filename search
//! index, file investigation, recent files, notes, skills, approvals and
//! analytics. Per-OS behaviour lives in `habibi_platform`; this crate has no
//! `cfg(target_os)` code.
//!
//! Construct with [`LocalServices::new`] and add it to the `Router`.

pub mod agent_sessions;
pub mod analytics;
pub mod apps;
pub mod browser_url;
pub mod daily_intent;
mod desktop;
pub mod files;
pub mod investigate;
pub mod note_preview;
pub mod notes;
pub mod recent;
pub mod search_index;
pub mod skills;
pub mod util;

mod routes;

use std::sync::Arc;

use habibi_core::services::{Llm, RecentFiles};
use habibi_core::{ApiRequest, ApiResponse, ApprovalService, Paths, Routes};

use crate::analytics::Analytics;
use crate::apps::AppIndex;
use crate::desktop::Desktop;
use crate::notes::NotesStore;
use crate::recent::{RecentRecorder, RecentStore};
use crate::search_index::{IndexOptions, LocalSearchIndex};
use crate::skills::SkillManifest;

pub struct LocalServices {
    paths: Paths,
    approvals: Arc<ApprovalService>,
    llm: Arc<dyn Llm>,
    desktop: Arc<dyn Desktop>,
    skills: Vec<SkillManifest>,
    analytics: Arc<Analytics>,
    notes: Arc<NotesStore>,
    recent: Arc<RecentStore>,
    search: LocalSearchIndex,
    apps: Arc<AppIndex>,
    sessions: Arc<agent_sessions::AgentSessions>,
}

impl LocalServices {
    /// Skill manifests are read from `paths.app_root/skills` now; the search
    /// index is built on first use.
    pub fn new(paths: Paths, approvals: Arc<ApprovalService>, llm: Arc<dyn Llm>) -> Arc<Self> {
        let search = LocalSearchIndex::new(&paths.home, IndexOptions::for_home(&paths.home));
        Self::build(
            paths,
            approvals,
            llm,
            Arc::new(desktop::System::default()),
            Arc::new(Analytics::from_env()),
            search,
        )
    }

    fn build(
        paths: Paths,
        approvals: Arc<ApprovalService>,
        llm: Arc<dyn Llm>,
        desktop: Arc<dyn Desktop>,
        analytics: Arc<Analytics>,
        search: LocalSearchIndex,
    ) -> Arc<Self> {
        Arc::new(Self {
            skills: skills::registry(&paths.app_root),
            notes: Arc::new(NotesStore::new(&paths.state_root)),
            recent: Arc::new(RecentStore::new(&paths.state_root, &paths.home)),
            sessions: Arc::new(agent_sessions::AgentSessions::new(&paths.home)),
            apps: Arc::new(AppIndex::default()),
            search,
            paths,
            approvals,
            llm,
            desktop,
            analytics,
        })
    }

    /// Recent-files recorder for other services (mail attachments, file tools…).
    pub fn recent(&self) -> Arc<dyn RecentFiles> {
        Arc::new(RecentRecorder(self.recent.clone()))
    }

    /// The filename index (e.g. for the shell to warm it at startup).
    pub fn search_index(&self) -> &LocalSearchIndex {
        &self.search
    }
}

#[async_trait::async_trait]
impl Routes for LocalServices {
    async fn handle(&self, request: &ApiRequest) -> Option<ApiResponse> {
        if let Some(response) = notes::handle(&self.notes, request).await {
            return Some(response);
        }
        if let Some(response) = recent::handle(&self.recent, request).await {
            return Some(response);
        }
        self.route(request).await
    }
}

#[cfg(test)]
mod route_tests;
