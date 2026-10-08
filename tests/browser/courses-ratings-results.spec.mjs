import { expect, test } from 'playwright/test';

const ratings = [
    { name: 'Ada Example', status: 'matched', overall_rating: 4.8, difficulty: 2.3, rating_count: 12, fetched_at: '2026-10-01T10:00:00Z', profile_url: 'https://www.ratemyprofessors.com/professor/123', search_url: 'https://www.ratemyprofessors.com/search/professors/298?q=Ada' },
    { name: 'Bea Example', status: 'matched', overall_rating: 3.4, difficulty: 2.3, rating_count: 8, fetched_at: '2026-10-01T10:00:00Z', profile_url: 'https://www.ratemyprofessors.com/professor/234' },
    { name: 'Cole Example', status: 'matched', overall_rating: 2.4, difficulty: 2.3, rating_count: 6, fetched_at: '2026-10-01T10:00:00Z', profile_url: 'https://www.ratemyprofessors.com/professor/345' },
    { name: 'Grace Example', status: 'unmatched', overall_rating: null, difficulty: null, rating_count: null, search_url: 'https://www.ratemyprofessors.com/search/professors/298?q=Grace' },
    { name: 'Sam Example', status: 'ambiguous', overall_rating: null, difficulty: null, rating_count: null, search_url: 'https://www.ratemyprofessors.com/search/professors/298?q=Sam' },
    { name: 'Lin Example', status: 'unrated', overall_rating: null, difficulty: null, rating_count: 0, profile_url: 'https://www.ratemyprofessors.com/professor/456' },
    { name: 'Max Example', status: 'unavailable', overall_rating: null, difficulty: null, rating_count: null },
];

async function mount(page, baseURL, { count = 625 } = {}) {
    const sections = Array.from({ length: count }, (_, index) => ({
        id: `Fall_2026|TEST|${index + 1}`, term: 'Fall_2026', course_code: `TEST ${String(index + 1).padStart(3, '0')}`,
        course_title: `Course ${index + 1}`, section_number: '001', instructor: 'My instructor label',
        overrides: { instructor: 'My instructor label' }, professor_ratings: ratings,
        enrollment_status: 'Closed', seats_available: 0, enrollment_capacity: 20, campus: 'Atlanta',
        schedule_display: 'Mon 9:00 AM-10:00 AM', meetings: [{ day: 'Mon', start: '0900', end: '1000' }],
    }));
    const errors = [];
    const batches = [];
    const sectionRequests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/atlas/terms', (route) => route.fulfill({ json: {
        terms: ['Fall_2026'], default_term: 'Fall_2026', term_metadata: { Fall_2026: { status: 'legacy' } },
    } }));
    await page.route('**/api/courses/saved', (route) => route.fulfill({ json: { courses: [] } }));
    await page.route('**/api/courses/tracks', (route) => route.fulfill({ json: { tracks: [] } }));
    await page.route('**/api/atlas/sections?*', (route) => {
        sectionRequests.push(route.request().url());
        return route.fulfill({ json: { sections } });
    });
    await page.route('**/api/atlas/sections/verify', (route) => {
        const batch = route.request().postDataJSON().section_ids;
        batches.push(batch);
        return route.fulfill({ json: { verified_by_id: Object.fromEntries(batch.map((id) => [id, { enrollment_status: 'Closed' }])) } });
    });
    await page.route('**/api/courses/section-status', (route) => {
        const id = route.request().postDataJSON().section_id;
        return route.fulfill({ json: { section: { id, seats_available: 0, enrollment_status: 'Closed' }, last_updated_at: '2026-10-07T10:00:00Z' } });
    });
    await page.goto(`${baseURL}/static/js/courses/index.js`);
    await page.setContent(`<!doctype html><html><body>
        <style>#courses-panel-content { block-size: 500px; overflow: auto; } .course-card { min-block-size: 240px; } .course-rating { display: block; }</style>
        <aside class="courses-panel"><p id="courses-result-summary"></p><p id="courses-catalog-status"></p>
        <input id="courses-search-input" type="search" aria-label="Search courses">
        <div id="courses-availability-filter"><label><input type="checkbox" value="closed">Closed only</label></div>
        <section id="courses-panel-content"></section></aside>
    </body></html>`);
    await page.evaluate(() => {
        window.APStudyHttp = { fetchJson: async (url, options = {}) => {
            const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
            return response.json();
        } };
        window.APSTUDY_COURSES_DEFAULT_TERM = 'Fall_2026';
        window.APSTUDY_COURSES_DEFAULT_CAMPUS = 'all';
    });
    await page.addScriptTag({ url: `${baseURL}/static/js/courses/index.js`, type: 'module' });
    await expect(page.locator('.course-card')).toHaveCount(Math.min(count, 100));
    await expect.poll(() => batches.flat().length).toBe(count);
    expect(errors).toEqual([]);
    return { batches, sectionRequests, errors };
}

test('over 500 courses are reachable and verified; pagination survives detail close and resets on filters and search', async ({ page, baseURL }) => {
    const { batches, sectionRequests, errors } = await mount(page, baseURL);
    expect(sectionRequests.every((url) => !new URL(url).searchParams.has('limit'))).toBe(true);
    expect(batches.every((batch) => batch.length <= 120)).toBe(true);
    await expect(page.locator('#courses-result-summary')).toContainText('625');
    await expect(page.locator('#courses-catalog-status')).toContainText('Coverage unverified');
    await page.getByLabel('Closed only').check();
    await expect(page.locator('.course-card')).toHaveCount(100);
    for (let count = 200; count <= 600; count += 100) {
        await page.getByRole('button', { name: 'Show more' }).click();
        await expect(page.locator('.course-card')).toHaveCount(count);
        await expect(page.locator('.course-card').nth(count - 100)).toBeFocused();
    }
    await page.getByRole('button', { name: 'Show more' }).click();
    await expect(page.locator('.course-card')).toHaveCount(625);
    await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
    const last = page.locator('.course-card').last();
    await last.scrollIntoViewIfNeeded();
    const before = await page.locator('#courses-panel-content').evaluate((node) => node.scrollTop);
    await last.press('Enter');
    await expect(page.getByRole('heading', { name: 'TEST 625' })).toBeVisible();
    await page.getByRole('button', { name: 'Close course details' }).click();
    await expect(page.locator('.course-card')).toHaveCount(625);
    await expect(last).toBeFocused();
    await expect.poll(() => page.locator('#courses-panel-content').evaluate((node) => node.scrollTop)).toBe(before);
    await page.getByLabel('Closed only').uncheck();
    await expect(page.locator('.course-card')).toHaveCount(100);
    await page.getByRole('button', { name: 'Show more' }).click();
    await expect(page.locator('.course-card')).toHaveCount(200);
    await page.getByRole('searchbox').fill('Course');
    await expect.poll(() => sectionRequests.length).toBe(2);
    await expect(page.locator('.course-card')).toHaveCount(100);
    expect(errors).toEqual([]);
});

test('RMP badges pair each name with its score and support mouse and keyboard without opening details', async ({ page, baseURL }) => {
    await mount(page, baseURL, { count: 1 });
    await page.addStyleTag({ url: `${baseURL}/static/css/courses.css` });
    await page.context().route('https://www.ratemyprofessors.com/**', (route) => route.fulfill({ body: '<h1>Profile fixture</h1>', contentType: 'text/html' }));
    const card = page.locator('.course-card');
    const cardRatings = card.locator('.course-card-schedule .course-rating');
    await expect(cardRatings).toHaveCount(ratings.length);
    for (const [name, score, color, background, href] of [
        ['Ada Example', '4.8', 'green', 'rgb(127, 246, 195)', 'https://www.ratemyprofessors.com/professor/123'],
        ['Bea Example', '3.4', 'yellow', 'rgb(255, 241, 112)', 'https://www.ratemyprofessors.com/professor/234'],
        ['Cole Example', '2.4', 'red', 'rgb(255, 156, 156)', 'https://www.ratemyprofessors.com/professor/345'],
        ['Grace Example', '–', 'unrated', null, 'https://www.ratemyprofessors.com/search/professors/298?q=Grace'],
        ['Sam Example', '–', 'unrated', null, 'https://www.ratemyprofessors.com/search/professors/298?q=Sam'],
        ['Lin Example', '–', 'unrated', null, 'https://www.ratemyprofessors.com/professor/456'],
        ['Max Example', '–', 'unrated', null, null],
    ]) {
        const nameLabel = card.getByText(name, { exact: true });
        await expect(nameLabel).toHaveCount(1);
        await expect(nameLabel).toBeVisible();
        const ratingRow = cardRatings.filter({ has: page.getByText(name, { exact: true }) });
        await expect(ratingRow).toHaveCount(1);
        await expect(ratingRow.locator('strong')).toHaveText(name);
        const badge = ratingRow.locator('strong + .course-rating-badge');
        await expect(badge).toHaveCount(1);
        await expect(badge).toHaveText(score);
        await expect(badge).toHaveClass(new RegExp(`\\bis-${color}\\b`));
        await expect(badge).toHaveAttribute('aria-label', new RegExp(name));
        await expect(badge).toHaveAttribute('title', new RegExp(name));
        if (href) {
            await expect(badge).toHaveJSProperty('tagName', 'A');
            await expect(badge).toHaveAttribute('href', href);
            await expect(badge).toHaveAttribute('target', '_blank');
            await expect(badge).toHaveAttribute('rel', 'noopener noreferrer');
            await expect(badge).toHaveAttribute('data-professor-rating-link', /^\d+$/);
            await expect(badge).toHaveAttribute('aria-label', /Rate My Professors.*new tab/);
        } else {
            await expect(badge).toHaveJSProperty('tagName', 'SPAN');
            await expect(badge).not.toHaveAttribute('href', /.+/);
        }
        if (score !== '–') await expect(badge).toHaveAttribute('aria-label', new RegExp(`${score.replace('.', '\\.')} out of 5`));
        const metrics = await badge.evaluate((node) => {
            const style = getComputedStyle(node);
            const bounds = node.getBoundingClientRect();
            const name = node.previousElementSibling.getBoundingClientRect();
            return { width: bounds.width, height: bounds.height, radius: parseFloat(style.borderTopLeftRadius),
                background: style.backgroundColor, gap: bounds.left - name.right,
                lineHeight: parseFloat(getComputedStyle(node.parentElement).lineHeight),
                centerDifference: Math.abs((bounds.top + bounds.height / 2) - (name.top + name.height / 2)) };
        });
        expect(metrics.width).toBeGreaterThanOrEqual(20);
        expect(metrics.width).toBeLessThanOrEqual(40);
        expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight);
        expect(metrics.radius).toBeGreaterThan(0);
        expect(metrics.radius).toBeLessThan(Math.min(metrics.width, metrics.height) / 2);
        expect(metrics.gap).toBeGreaterThanOrEqual(0);
        expect(metrics.gap).toBeLessThanOrEqual(12);
        expect(metrics.centerDifference).toBeLessThanOrEqual(2);
        if (background) expect(metrics.background).toBe(background);
        else {
            const channels = metrics.background.match(/\d+/g);
            expect(channels[0]).toBe(channels[1]);
            expect(channels[1]).toBe(channels[2]);
        }
    }
    await expect(card).not.toContainText('12 ratings');
    await expect(card).not.toContainText('4.8/5');
    await expect(card).not.toContainText('RMP');
    const link = cardRatings.filter({ has: page.getByText('Ada Example', { exact: true }) }).getByRole('link');
    for (const activation of ['mouse', 'keyboard']) {
        const popupPromise = page.waitForEvent('popup');
        if (activation === 'mouse') await link.click();
        else { await link.focus(); await page.keyboard.press('Enter'); }
        const popup = await popupPromise;
        await popup.waitForLoadState();
        expect(await popup.evaluate(() => window.opener === null)).toBe(true);
        await popup.close();
        await expect(page.locator('.course-card')).toHaveCount(1);
        await expect(page.getByRole('button', { name: 'Close course details' })).toHaveCount(0);
    }
    const refresh = page.waitForResponse('**/api/courses/section-status');
    await card.press('Enter');
    await refresh;
    await expect(page.getByRole('heading', { name: 'Professor ratings' })).toBeVisible();
    const detail = page.locator('.courses-detail');
    const detailRating = detail.locator('.course-rating').filter({ has: page.getByText('Ada Example', { exact: true }) });
    await expect(detailRating.locator('.course-rating-heading > strong')).toHaveText('Ada Example');
    await expect(detailRating.locator('.course-rating-heading > strong + .course-rating-badge')).toHaveText('4.8');
    await expect(page.locator('.courses-detail')).toContainText('12 ratings · Difficulty 2.3/5 · Updated');
    await expect(page.locator('.courses-detail')).toContainText('Ratings refer to Atlas instructors; your instructor label is customized.');
    await expect(page.locator('.courses-detail')).not.toContainText('Difficulty 0.0');
});
