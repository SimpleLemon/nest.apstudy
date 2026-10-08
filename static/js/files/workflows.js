import { createUploadWorkflow } from "./upload-workflow.js";
import { createSharingWorkflow } from "./sharing-workflow.js";
import { createDownloadWorkflow } from "./download-workflow.js";
import { createSelectionWorkflow } from "./selection-workflow.js";

// Each workflow receives only the capabilities it needs. The entry point supplies
// these ports; workflows coordinate through the shared file-manager state.
export function createFilesWorkflows({ state, els, upload, sharing, downloads, selection }) {
    return {
        ...createUploadWorkflow({ state, els, ...upload }),
        ...createSharingWorkflow({ state, els, ...sharing }),
        ...createDownloadWorkflow({ state, els, ...downloads }),
        ...createSelectionWorkflow({ state, els, ...selection }),
    };
}
