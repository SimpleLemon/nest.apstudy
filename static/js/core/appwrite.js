const configMeta = typeof document !== "undefined"
    ? {
        endpoint: document.querySelector('meta[name="apstudy-appwrite-endpoint"]')?.content,
        projectId: document.querySelector('meta[name="apstudy-appwrite-project-id"]')?.content,
    }
    : {};
const APPWRITE_ENDPOINT = configMeta.endpoint || "https://nyc.cloud.appwrite.io/v1";
const APPWRITE_PROJECT_ID = configMeta.projectId || "69f77663000c16abdff2";

const client = new Appwrite.Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID);

const account = new Appwrite.Account(client);
const databases = new Appwrite.Databases(client);
const storage = new Appwrite.Storage(client);

window.APPWRITE_ENDPOINT = APPWRITE_ENDPOINT;
window.APPWRITE_PROJECT_ID = APPWRITE_PROJECT_ID;
window.client = client;
window.account = account;
window.databases = databases;
window.storage = storage;
