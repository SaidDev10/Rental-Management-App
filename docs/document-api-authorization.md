# Document API authorization and uploads

The document and maintenance-ticket routes require `Authorization: Bearer <access-token>`. The API verifies the token and takes the account ID and role from its claims; caller-supplied account IDs cannot select or change the account scope. These routes are owner-only. Requests without an owner role are forbidden.

## Documents

| Method and path | Purpose |
|---|---|
| `GET /documents?linkedEntityType=&linkedEntityId=&documentType=` | List document metadata; returns `{ data, nextCursor }`. |
| `GET /documents/:id` | Read metadata only; returns `{ data }`. |
| `POST /documents/presign` | Request a direct-to-S3 upload URL. |
| `POST /documents` | Confirm an upload and create its metadata record. |
| `GET /documents/:id/download-url` | Request a download URL; returns `{ url, expiresIn: 300 }`. |
| `DELETE /documents/:id` | Soft-delete metadata; the S3 object is retained. |

Presign JSON:

```json
{
  "documentType": "lease",
  "linkedEntityType": "Lease",
  "linkedEntityId": "lease-id",
  "contentType": "image/jpeg",
  "sizeBytes": 12345
}
```

`documentType` is one of `lease`, `quittance`, `fiche_police`, `etat_des_lieux`, `invoice`, `id_document`, or `other`. `linkedEntityType` is one of `Lease`, `Payment`, `Tenant`, `Property`, or `MaintenanceTicket`. Uploads accept only `image/jpeg`, `image/png`, and `image/webp`; `sizeBytes` must be a positive integer no greater than 10 MiB.

The presign and confirm operations check that the linked entity exists in the authenticated account. The confirm request repeats the presign fields and adds `s3Key`. Confirmation accepts only a key in that account's document prefix, then checks the stored object's content type and actual size against the declared values (and the 10 MiB limit) before creating metadata. Metadata reads and downloads are also scoped to the authenticated account.

Upload and download URLs expire after 300 seconds. The upload signature pins the `Content-Type`; send the matching header on the direct S3 `PUT`. Use the returned URL only for its intended operation. A presigned URL is a temporary bearer capability: do not log it, expose it to other users, or include it in support messages. Downloads are signed as attachments with a sanitized filename. The API's bearer token is used for API requests, not for the direct S3 request.

## Maintenance-ticket attachment upload

`POST /maintenance/tickets/:id/attachments` accepts:

```json
{ "contentType": "image/jpeg", "sizeBytes": 12345 }
```

It is owner-only and verifies that the ticket exists and is not soft-deleted in the authenticated account. The declared content type must be `image/jpeg`, `image/png`, or `image/webp`; the declared size must be a positive integer no greater than 10 MiB. The response is `{ data: { uploadUrl, s3Key, expiresIn } }`; the upload URL expires after 300 seconds and pins the content type. Send that exact `Content-Type` on the direct S3 `PUT`, and handle the URL as a temporary bearer capability as described above.

After a successful S3 `PUT`, confirm it with `POST /maintenance/tickets/:id/attachments/confirm`:

```json
{
  "s3Key": "accounts/<account>/documents/<upload-id>.jpg",
  "contentType": "image/jpeg",
  "sizeBytes": 12345
}
```

Confirmation is owner-only and account-scoped. It requires an active ticket in the authenticated account, accepts only the caller's document key prefix, checks the stored S3 object's content type and actual size against the declaration (including the 10 MiB limit), and then appends `{s3Key, mimeType, sizeBytes}` to the ticket's attachment metadata. Missing or mismatched objects are not persisted.
