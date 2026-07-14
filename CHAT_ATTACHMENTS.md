# Chat attachments rollout

Chat attachments are private and are enabled only when `APPWRITE_CHAT_ATTACHMENTS_BUCKET_ID` is set. Create a bucket with file security enabled, no public read permissions, and a maximum file size of at least 50 MiB. The server API key needs create, read, and delete access.

Create a `chat_attachments` Appwrite TablesDB table with the attributes represented in `migrations/009_chat_attachments.sql`. Use string attributes for IDs, scope, status, names, MIME/kind/encoding, SHA-256, storage IDs, and provider data; integer attributes for byte sizes and dimensions; and datetime attributes for timestamps. Add indexes for:

- `user_id`
- `message_id`
- `scope_type` plus `scope_id`
- `status` plus `created_at`

The bucket counts against the existing account storage entitlement. The separate `max_chat_attachment_size_bytes` tier setting defaults to 10 MiB for Free and 50 MiB for Grade A, Grade AA, and Developer accounts.

Set `GIPHY_API_KEY` to enable GIF search. The client uses `pg` filtering and displays required attribution; selected IDs are resolved again by the server before persistence. If the key is absent, only the GIF tab is disabled.

After provisioning, run:

```bash
python scripts/verify_appwrite_storage.py
```

The daily scheduler removes pending uploads older than 24 hours. Message deletion and account deletion remove both metadata and stored objects.
