/**
 * Records returned by the notes review API and shared with editor decorations.
 * @typedef {object} ReviewAuthor
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [color]
 *
 * @typedef {object} CommentAnchor
 * @property {'document'|'legacy'|'yjs'} kind
 * @property {'attached'|'detached'} state
 * @property {number} version
 * @property {string|null} [relative_start]
 * @property {string|null} [relative_end]
 * @property {string|null} [start_block_id]
 * @property {string|null} [end_block_id]
 * @property {number|null} [start_offset]
 * @property {number|null} [end_offset]
 * @property {string} [quoted_text]
 * @property {string} [context_before]
 * @property {string} [context_after]
 *
 * @typedef {object} CommentReply
 * @property {string} id
 * @property {string} body
 * @property {ReviewAuthor|null} [author]
 * @property {string|null} [deleted_at]
 * @property {string|null} [edited_at]
 * @property {boolean} [can_edit]
 * @property {boolean} [can_delete]
 *
 * @typedef {CommentReply & {status: 'open'|'resolved', anchor: CommentAnchor,
 *   replies?: CommentReply[], can_resolve?: boolean}} CommentThread
 *
 * @typedef {object} ReviewSuggestion
 * @property {string} id
 * @property {'open'|'accepted'|'rejected'|'conflicted'} status
 * @property {ReviewAuthor|null} [author]
 * @property {string} [summary]
 * @property {string} [operation_kind]
 *
 * @typedef {object} NoteVersion
 * @property {string} id
 * @property {string|null} [name]
 * @property {string} [reason]
 * @property {string} [created_at]
 * @property {ReviewAuthor|null} [actor]
 *
 * @typedef {{threads: CommentThread[], suggestions: ReviewSuggestion[],
 *   versions: NoteVersion[]}} ReviewRecords
 *
 * @typedef {object} ReviewPanelOptions
 * @property {string} noteId
 * @property {boolean} canReview
 * @property {boolean} canManageReviews
 * @property {boolean} canViewVersions
 * @property {HTMLElement} panel
 * @property {HTMLElement|null} [reviewButton]
 * @property {HTMLElement|null} [historyButton]
 * @property {{show?: (options: {message: string, type: string}) => void}} [toast]
 * @property {() => CommentAnchor} [captureAnchor]
 * @property {(threads: CommentThread[], activeId: string|null) => void} [onThreads]
 * @property {(thread: CommentThread) => void} [onSelectThread]
 * @property {(thread: CommentThread) => number|null} [anchorTop]
 *
 * @typedef {object} ReviewPanelController
 * @property {(mode?: 'review'|'history') => Promise<void>} open
 * @property {() => void} close
 * @property {(anchor?: CommentAnchor) => void} startComment
 * @property {(id: string) => void} selectThread
 * @property {() => Promise<void>} refresh
 * @property {() => void} refreshDecorations
 * @property {() => void} destroy
 */
export {};
