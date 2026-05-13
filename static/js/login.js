(function() {
    const successRedirect = `${window.location.origin}/login`;
    const defaultRedirect = `${window.location.origin}/calendar`;
    const failureRedirect = `${window.location.origin}/login`;
    const providerStorageKey = "apstudy-oauth-provider";

    function getAccount() {
        return window.account || (typeof account !== "undefined" ? account : null);
    }

    function exchangeAppwriteSession(provider, accountData, providerAccessToken) {
        if (!accountData) {
            return Promise.reject(new Error("Missing Appwrite account data"));
        }
        const userId = accountData.$id || accountData.id;
        const email = accountData.email;
        if (!userId) {
            return Promise.reject(new Error("Missing Appwrite user id"));
        }
        const body = { user_id: userId, email: email };
        if (provider) body.provider = provider;
        if (providerAccessToken) body.provider_access_token = providerAccessToken;
        return fetch("/auth/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }).then(function(response) {
            if (!response.ok) {
                throw new Error("Failed to exchange session");
            }
            return response.json();
        });
    }

    function getCurrentSessionDetails() {
        const appwriteAccount = getAccount();
        if (!appwriteAccount || typeof appwriteAccount.getSession !== "function") {
            return Promise.resolve({});
        }
        return appwriteAccount.getSession("current")
            .then(function(sessionData) {
                return {
                    provider: sessionData && sessionData.provider,
                    providerAccessToken: sessionData && sessionData.providerAccessToken,
                };
            })
            .catch(function() {
                return {};
            });
    }

    function shouldSkipAutoLogin() {
        const params = new URLSearchParams(window.location.search);
        if (params.get("logged_out") === "1") {
            return true;
        }
        try {
            return sessionStorage.getItem("apstudy-logged-out") === "true";
        } catch (error) {
            return false;
        }
    }

    const skipAutoLogin = shouldSkipAutoLogin();
    const appwriteAccount = getAccount();

    if (appwriteAccount && typeof appwriteAccount.get === "function" && !skipAutoLogin) {
        appwriteAccount.get()
            .then(function(acc) {
                return getCurrentSessionDetails().then(function(sessionDetails) {
                    const provider = sessionStorage.getItem(providerStorageKey)
                        || sessionDetails.provider
                        || "appwrite";
                    return exchangeAppwriteSession(
                        provider,
                        acc,
                        sessionDetails.providerAccessToken
                    ).then(function(data) {
                        sessionStorage.removeItem(providerStorageKey);
                        const redirectTo = (data && data.redirect) ? data.redirect : defaultRedirect;
                        window.location.href = redirectTo;
                    });
                });
            })
            .catch(function() {
                // No active session, stay on login page.
            });
    }

    if (skipAutoLogin) {
        try {
            sessionStorage.removeItem("apstudy-logged-out");
        } catch (error) {
            // Ignore storage errors.
        }
    }

    [
        { id: "oauth-github", provider: "github" },
        { id: "oauth-discord", provider: "discord" },
        { id: "oauth-google", provider: "google" },
    ].forEach(function(entry) {
        const button = document.getElementById(entry.id);
        if (!button) {
            return;
        }
        button.addEventListener("click", function() {
            const accountForProvider = getAccount();
            if (!accountForProvider || typeof accountForProvider.createOAuth2Session !== "function") {
                console.error("Appwrite account client is not available.");
                return;
            }
            sessionStorage.setItem(providerStorageKey, entry.provider);
            accountForProvider.createOAuth2Session(entry.provider, successRedirect, failureRedirect);
        });
    });
})();
