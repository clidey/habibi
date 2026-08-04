/** Static launcher entries. Dynamic skills live in their own feature modules. */
export const launcherResults = [
  { icon:'whatsapp', glyph:'◔', title:'WhatsApp', meta:'Open real chats, contacts, and recent messages', tag:'APP', type:'whatsapp' },
  { icon:'calendar', glyph:'□', title:'Create event', meta:'Prepare a calendar event for approval', tag:'EVENT', type:'event' },
  { icon:'calendar', glyph:'□', title:'Upcoming events', meta:'View your real calendar over the next two weeks', tag:'CALENDAR', type:'agenda' },
  { icon:'files', glyph:'⌁', title:'Find local files', meta:'Search your Mac with Spotlight', tag:'FILES', type:'file' },
  { icon:'gmail', glyph:'M', title:'Mail', meta:'Connect Gmail or Zoho Mail to search threads and reply', tag:'MAIL', type:'email' },
  { icon:'agents', glyph:'✣', title:'Open Claude Code', meta:'Start a task with selected files and approved skills', tag:'AGENT', type:'agent' },
  { icon:'agents', glyph:'⚙', title:'System Settings', meta:'Open macOS settings', tag:'MAC', type:'system', systemAction:'settings' },
  { icon:'agents', glyph:'◉', title:'Applications', meta:'Open your installed Mac applications', tag:'MAC', type:'system', systemAction:'applications' },
  { icon:'agents', glyph:'◐', title:'Sleep Mac', meta:'Put this Mac to sleep after confirmation', tag:'SYSTEM', type:'system', systemAction:'sleep' },
  { icon:'agents', glyph:'↻', title:'Restart Mac', meta:'Restart this Mac after confirmation', tag:'SYSTEM', type:'system', systemAction:'restart' },
  { icon:'agents', glyph:'⏻', title:'Shut Down Mac', meta:'Shut down this Mac after confirmation', tag:'SYSTEM', type:'system', systemAction:'shutdown' },
  { icon:'agents', glyph:'◼', title:'Lock Screen', meta:'Lock this Mac after confirmation', tag:'SYSTEM', type:'system', systemAction:'lock' },
  { icon:'agents', glyph:'◑', title:'Toggle dark mode', meta:'Change macOS appearance after confirmation', tag:'SYSTEM', type:'system', systemAction:'darkMode' },
  { icon:'agents', glyph:'⌫', title:'Empty Trash', meta:'Permanently remove Trash items after confirmation', tag:'SYSTEM', type:'system', systemAction:'emptyTrash' },
];
