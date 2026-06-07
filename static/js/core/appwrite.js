const APPWRITE_ENDPOINT = "https://nyc.cloud.appwrite.io/v1";
const APPWRITE_PROJECT_ID = "69f77663000c16abdff2";

const client = new Appwrite.Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID);

const account = new Appwrite.Account(client);
const databases = new Appwrite.Databases(client);
const storage = new Appwrite.Storage(client);
const presences = Appwrite.Presences ? new Appwrite.Presences(client) : null;
const realtime = Appwrite.Realtime ? new Appwrite.Realtime(client) : null;

if (!presences) {
    console.warn("Appwrite Presences are unavailable. Chat presence will fall back to cached offline state.");
}

window.APPWRITE_ENDPOINT = APPWRITE_ENDPOINT;
window.APPWRITE_PROJECT_ID = APPWRITE_PROJECT_ID;
window.client = client;
window.account = account;
window.databases = databases;
window.storage = storage;
window.presences = presences;
window.realtime = realtime;
window.Permission = Appwrite.Permission;
window.Role = Appwrite.Role;
window.Query = Appwrite.Query;
window.Channel = Appwrite.Channel;
