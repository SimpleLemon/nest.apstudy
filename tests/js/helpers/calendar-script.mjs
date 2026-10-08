import { buildSync } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../static/js/calendar/', import.meta.url));
const files = {
    State: 'state.js', Preferences: 'preferences.js', Data: 'integrations/data.js',
    Courses: 'integrations/courses.js', CourseModal: 'integrations/course-modal.js',
    Share: 'integrations/share.js', Sources: 'integrations/sources.js',
    Utils: 'utils.js', Core: 'core.js', Menu: 'menu.js', Controls: 'controls.js',
    UiActions: 'events/ui-actions.js', EventMenu: 'events/context-menu.js',
    EventRender: 'views/event-render.js', RenderShell: 'views/render-shell.js',
    WeekView: 'views/week-view.js', MonthView: 'views/month-view.js', Agenda: 'views/agenda.js',
    Lifecycle: 'lifecycle.js', CourseControls: 'integrations/course-controls.js', HoverCard: 'events/hover-card.js',
};

// Bundle the unchanged entry and its actual ESM imports. Namespaces only expose
// public exports to existing VM fixtures; no private declarations are rewritten.
export function calendarScript(source, namespace) {
    const relative = files[namespace.replace(/^APStudy(?:Calendar)?/, '')];
    if (!relative) throw new Error(`Unknown Calendar fixture entry: ${namespace}`);
    const file = path.join(root, relative);
    const bundled = buildSync({
        stdin: { contents: source, sourcefile: file, resolveDir: path.dirname(file) },
        bundle: true, write: false, platform: 'browser', format: 'iife',
        globalName: '__calendarModuleFixture',
    }).outputFiles[0].text;
    return `${bundled}\nwindow.${namespace} = __calendarModuleFixture;\n`;
}
