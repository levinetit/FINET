import 'fake_server.dart';

/// `GET /api/v1/app/android/latest` pe [FakeServer].
class FakeUpdate {
  FakeUpdate(this.server) {
    server.on('GET /api/v1/app/android/latest', (o) {
      if (!server.authorized(o)) {
        return finetError(401, 'unauthenticated', 'Sesiune invalidă');
      }
      calls++;
      final r = release;
      if (r == null) {
        return finetError(
          404,
          'android_release_unavailable',
          'Nu există încă o versiune Android publicată.',
        );
      }
      return jsonBody({'data': r});
    });
  }

  final FakeServer server;
  int calls = 0;

  /// Răspunsul serverului; `null` = nicio versiune publicată (404).
  Map<String, Object?>? release;

  static Map<String, Object?> version({
    String name = '1.2.0',
    int code = 20,
    int min = 1,
    String url = 'https://github.com/exemplu/finet/releases/download/FINET-v1.2.0/finet-1.2.0.apk',
  }) => {
    'versionName': name,
    'versionCode': code,
    'minSupportedVersionCode': min,
    'url': url,
    'sha256': 'a' * 64,
    'sizeBytes': 23456789,
    'notes': 'Scanare mai rapidă; corecturi.',
    'publishedAt': '2026-11-01T08:00:00Z',
  };
}
