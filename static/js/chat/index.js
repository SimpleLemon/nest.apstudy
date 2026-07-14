import { createAttachmentManager } from "./attachments.js";
import { createMediaPicker } from "./media-picker.js";
import { createMessageMedia } from "./message-media.js";
import { startChatRuntime } from "./runtime.js";

const attachments = createAttachmentManager();
const mediaPicker = createMediaPicker();
const messageMedia = createMessageMedia();

startChatRuntime({ attachments, mediaPicker, messageMedia });
