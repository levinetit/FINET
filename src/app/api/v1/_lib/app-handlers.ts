import "server-only";

import { androidReleaseJson, readAndroidRelease } from "@/modules/app-release/android";

import { ApiError, type ApiDeps, handle, json, readQuery } from "./http";

/**
 * `GET /api/v1/app/android/latest` (Faza 9; promptul Android 12.1; ADR 0020): ultima versiune a
 * aplicației Android, din `<STORAGE_DIR>/app/android-latest.json`. Aceleași reguli ca restul
 * `/api/v1`: Access (proxy), sesiune (cookie sau bearer), `X-FINET-Client`. Fără versiune
 * publicată (sau fișier invalid): 404 cu codul fix `android_release_unavailable`.
 * `Cache-Control: no-store` (ca tot API-ul).
 */
export function androidLatestHandler(request: Request, deps: ApiDeps): Promise<Response> {
  return handle(request, deps, async () => {
    readQuery(request, {});
    const release = await readAndroidRelease(deps.config.storage.dir);
    if (!release) {
      throw new ApiError(
        404,
        "android_release_unavailable",
        "Nu există încă o versiune Android publicată.",
      );
    }
    return json({ data: androidReleaseJson(release) });
  });
}
