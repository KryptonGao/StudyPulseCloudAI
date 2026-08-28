import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function page(host, path) {
	return SELF.fetch("https://" + host + path, { method: "GET" });
}

describe("static UI pages", () => {
	it("serves the admin shell with dynamic CSRF bootstrap values", async () => {
		const response = await page("admin.chenkai.space", "/admin");
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain('<link rel="stylesheet" href="/pages/admin/styles.css">');
		expect(html).toContain('<script src="/pages/admin/app.js" defer></script>');
		expect(html).not.toContain("__CSRF_TOKEN__");
		expect(html).not.toContain("__HAS_CF_ACCESS__");
		expect(response.headers.get("Set-Cookie")).toMatch(/admin_csrf=[0-9a-f]{64}/);
	});

	it("serves dashboard aliases from the same static shell", async () => {
		for (const path of ["/dashboard", "/contributions", "/feedback", "/security"]) {
			const response = await page("dash.studypulse.chenkai.space", path);
			const html = await response.text();
			expect(response.status).toBe(200);
			expect(html).toContain('<link rel="stylesheet" href="/pages/dashboard/styles.css">');
			expect(html).toContain('<script src="/pages/dashboard/app.js" defer></script>');
		}
	});

	it("serves auth, support, GitHub bind, and appeal shells", async () => {
		const cases = [
			["auth.chenkai.space", "/login", "/pages/auth/app.js"],
			["support.chenkai.space", "/", "/pages/support/app.js"],
			["auth.chenkai.space", "/oauth/github/bind", "/pages/auth-bind/app.js"],
			["support.chenkai.space", "/appeal/BAN_invalid", "/pages/appeal/app.js"],
		];
		for (const [host, path, script] of cases) {
			const response = await page(host, path);
			const html = await response.text();
			expect(response.status).toBe(200);
			expect(html).toContain('<script src="' + script + '" defer></script>');
		}
	});

	it("keeps production hostnames isolated from each other", async () => {
		const adminPage = await page("admin.chenkai.space", "/admin");
		expect(adminPage.status).toBe(200);
		expect(await adminPage.text()).toContain("/pages/admin/app.js");

		const dashboardOnAdmin = await page("admin.chenkai.space", "/dashboard");
		expect(dashboardOnAdmin.status).toBe(404);

		const supportHome = await page("support.chenkai.space", "/");
		expect(supportHome.status).toBe(200);
		expect(await supportHome.text()).toContain("/pages/support/app.js");

		const adminOnSupport = await page("support.chenkai.space", "/admin");
		expect(adminOnSupport.status).toBe(404);

		const dashHome = await page("dash.studypulse.chenkai.space", "/");
		expect(dashHome.status).toBe(200);
		expect(await dashHome.text()).toContain("/pages/dashboard/app.js");

		const adminOnDash = await page("dash.studypulse.chenkai.space", "/admin");
		expect(adminOnDash.status).toBe(404);

		const authLogin = await page("auth.chenkai.space", "/login");
		expect(authLogin.status).toBe(200);
		expect(await authLogin.text()).toContain("/pages/auth/app.js");
	});

	it("serves static CSS and JavaScript directly from the ASSETS collection", async () => {
		const response = await page("auth.chenkai.space", "/pages/auth/app.js");
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/javascript");
		expect(await response.text()).toContain("getAppReturnTo");

		const adminApp = await page("admin.chenkai.space", "/pages/admin/app.js");
		expect(await adminApp.text()).toContain("测试此模型连通性");
	});
});
