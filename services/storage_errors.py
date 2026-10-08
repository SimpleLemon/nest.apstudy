"""Errors shared by upload storage adapters and their HTTP routes."""


class StorageError(Exception):
    status_code = 500
    code = "storage_error"


class StorageNotFound(StorageError):
    status_code = 404
    code = "storage_not_found"


class StorageIntegrityError(StorageError):
    code = "storage_integrity_error"


class StorageUnavailable(StorageError):
    status_code = 503
    code = "storage_unavailable"


class StorageValidationError(StorageError, ValueError):
    status_code = 400
    code = "storage_validation_error"


class StorageMutationPaused(StorageUnavailable):
    code = "storage_mutations_paused"
