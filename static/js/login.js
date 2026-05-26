(function() {
    const successRedirect = `${window.location.origin}/login`;
    const defaultRedirect = `${window.location.origin}/calendar`;
    const failureRedirect = `${window.location.origin}/login`;
    const providerStorageKey = "apstudy-oauth-provider";

    function getAccount() {
        return window.account || (typeof account !== "undefined" ? account : null);
    }

    function warnSessionStorageFailure(action, error) {
        console.warn(`Unable to ${action} session storage.`, error);
    }

    function readSessionStorageItem(key) {
        try {
            return sessionStorage.getItem(key);
        } catch (error) {
            warnSessionStorageFailure("read from", error);
            return null;
        }
    }

    function writeSessionStorageItem(key, value) {
        try {
            sessionStorage.setItem(key, value);
        } catch (error) {
            warnSessionStorageFailure("write to", error);
        }
    }

    function removeSessionStorageItem(key) {
        try {
            sessionStorage.removeItem(key);
        } catch (error) {
            warnSessionStorageFailure("remove from", error);
        }
    }

    function createAppwriteJwt(appwriteAccount) {
        if (!appwriteAccount || typeof appwriteAccount.createJWT !== "function") {
            return Promise.resolve("");
        }
        return appwriteAccount.createJWT()
            .then(function(data) {
                return (data && (data.jwt || data.secret || data.token)) || "";
            })
            .catch(function(error) {
                console.warn("Unable to create Appwrite JWT for session exchange.", error);
                return "";
            });
    }

    function exchangeAppwriteSession(provider, accountData, proof) {
        if (!accountData) {
            return Promise.reject(new Error("Missing Appwrite account data"));
        }
        const userId = accountData.$id || accountData.id;
        const email = accountData.email;
        if (!userId) {
            return Promise.reject(new Error("Missing Appwrite user id"));
        }
        const jwt = proof && proof.jwt;
        const providerAccessToken = proof && proof.providerAccessToken;
        if (!jwt && !providerAccessToken) {
            return Promise.resolve(null);
        }
        const body = { user_id: userId, email: email };
        if (provider) body.provider = provider;
        if (jwt) body.jwt = jwt;
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
        return readSessionStorageItem("apstudy-logged-out") === "true";
    }

    const skipAutoLogin = shouldSkipAutoLogin();
    const appwriteAccount = getAccount();

    if (appwriteAccount && typeof appwriteAccount.get === "function" && !skipAutoLogin) {
        appwriteAccount.get()
            .then(function(acc) {
                return Promise.all([
                    getCurrentSessionDetails(),
                    createAppwriteJwt(appwriteAccount),
                ]).then(function(results) {
                    const sessionDetails = results[0] || {};
                    const jwt = results[1] || "";
                    const provider = readSessionStorageItem(providerStorageKey)
                        || sessionDetails.provider
                        || "appwrite";
                    return exchangeAppwriteSession(
                        provider,
                        acc,
                        {
                            jwt: jwt,
                            providerAccessToken: sessionDetails.providerAccessToken,
                        }
                    )
                        .then(function(data) {
                            if (!data) {
                                return;
                            }
                            removeSessionStorageItem(providerStorageKey);
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
        removeSessionStorageItem("apstudy-logged-out");
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
            writeSessionStorageItem(providerStorageKey, entry.provider);
            accountForProvider.createOAuth2Session(entry.provider, successRedirect, failureRedirect);
        });
    });
})();
