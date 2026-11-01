import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

typedef RouteHandler = ResponseBody Function(RequestOptions options);

ResponseBody jsonBody(
  Object? body, {
  int status = 200,
  Map<String, List<String>>? headers,
}) {
  return ResponseBody.fromString(
    jsonEncode(body),
    status,
    headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
      ...?headers,
    },
  );
}

ResponseBody emptyBody(int status) => ResponseBody.fromString('', status);

ResponseBody finetError(int status, String code, String message) => jsonBody({
  'error': {'code': code, 'message': message},
}, status: status);

/// Server FINET simulat: răspunde după „METODĂ /cale” și păstrează cererile primite. Nu face
/// rețea reală (promptul Android Faza B: backendul real de test cere un hostname de la operator).
class FakeServer implements HttpClientAdapter {
  FakeServer() {
    _standard();
  }

  static const email = 'ana@exemplu.ro';
  static const password = 'parola-fictiva-123';
  static const token = 'tokenFictiv.semnatura';

  final Map<String, RouteHandler> routes = {};
  final List<RequestOptions> requests = [];

  /// Dacă e `true`, orice cerere eșuează ca lipsă de rețea.
  bool offline = false;

  /// Dacă e `true`, rutele `/api/v1/*` răspund 401 (sesiune expirată/revocată).
  bool sessionRevoked = false;

  /// Gospodăria activă pe server (pentru `PUT /households/active`).
  String activeHousehold = hhOne;

  /// Consimțământul `usageStats` de pe server.
  bool usageStatsGranted = false;

  /// Loturile de evenimente primite (corpul `events`).
  final List<List<Map<String, Object?>>> eventBatches = [];

  static const hhOne = '11111111-1111-4111-8111-111111111111';
  static const hhTwo = '22222222-2222-4222-8222-222222222222';

  void on(String key, RouteHandler handler) => routes[key] = handler;

  Iterable<RequestOptions> requestsTo(String key) =>
      requests.where((r) => '${r.method} ${r.uri.path}' == key);

  bool get hasToken =>
      requests.any((r) => r.headers.containsKey('Authorization'));

  List<Map<String, Object?>> get allEvents => [
    for (final b in eventBatches) ...b,
  ];

  Map<String, Object?> _household(String id, String name, String role) => {
    'id': id,
    'name': name,
    'defaultCurrency': 'RON',
    'timezone': 'Europe/Bucharest',
    'role': role,
    'current': activeHousehold == id,
    'joinedAt': '2026-01-01T00:00:00.000Z',
  };

  bool _authorized(RequestOptions o) =>
      !sessionRevoked && o.headers['Authorization'] == 'Bearer $token';

  void _standard() {
    on('POST /api/auth/sign-in/email', (o) {
      final body = o.data as Map;
      if (body['email'] == email && body['password'] == password) {
        return jsonBody(
          {
            'user': {'id': 'u1'},
          },
          headers: {
            'set-auth-token': [token],
          },
        );
      }
      return jsonBody({
        'code': 'INVALID_EMAIL_OR_PASSWORD',
        'message': 'Invalid email or password',
      }, status: 401);
    });
    on('POST /api/auth/sign-out', (o) => jsonBody({'success': true}));
    on('GET /api/v1/me', (o) {
      if (!_authorized(o)) {
        return finetError(401, 'unauthenticated', 'Sesiune invalidă');
      }
      final current = activeHousehold == hhOne
          ? ('Casa Ana', hhOne)
          : ('Casa de vacanță', hhTwo);
      return jsonBody({
        'data': {
          'user': {
            'id': 'u1',
            'email': email,
            'name': 'Ana Popescu',
            'emailVerified': true,
            'isPlatformAdmin': false,
            'createdAt': '2026-01-01T00:00:00.000Z',
          },
          'preferences': {
            'locale': 'ro',
            'timezone': 'Europe/Bucharest',
            'defaultCurrency': 'RON',
            'theme': 'system',
          },
          'household': {
            'id': current.$2,
            'name': current.$1,
            'defaultCurrency': 'RON',
            'timezone': 'Europe/Bucharest',
            'role': 'owner',
          },
        },
      });
    });
    on('GET /api/v1/households', (o) {
      if (!_authorized(o)) {
        return finetError(401, 'unauthenticated', 'Sesiune invalidă');
      }
      return jsonBody({
        'data': [
          _household(hhOne, 'Casa Ana', 'owner'),
          _household(hhTwo, 'Casa de vacanță', 'member'),
        ],
      });
    });
    on('PUT /api/v1/households/active', (o) {
      if (!_authorized(o)) {
        return finetError(401, 'unauthenticated', 'Sesiune invalidă');
      }
      activeHousehold = (o.data as Map)['householdId'] as String;
      return jsonBody({'data': _household(activeHousehold, 'x', 'owner')});
    });
    on('GET /api/v1/me/consents', (o) {
      if (!_authorized(o)) {
        return finetError(401, 'unauthenticated', 'Sesiune invalidă');
      }
      return jsonBody({
        'data': [
          {
            'kind': 'usageStats',
            'granted': usageStatsGranted,
            'grantedAt': null,
            'revokedAt': null,
          },
        ],
      });
    });
    on('PUT /api/v1/me/consents', (o) {
      if (!_authorized(o)) {
        return finetError(401, 'unauthenticated', 'Sesiune invalidă');
      }
      usageStatsGranted = (o.data as Map)['usageStats'] == true;
      return jsonBody({'data': <Object>[]});
    });
    on('POST /api/v1/app/events', (o) {
      if (!_authorized(o)) {
        return finetError(401, 'unauthenticated', 'Sesiune invalidă');
      }
      if (!usageStatsGranted) {
        return finetError(403, 'forbidden', 'Fără consimțământ');
      }
      final events = (o.data as Map)['events'] as List;
      eventBatches.add([
        for (final e in events) Map<String, Object?>.from(e as Map),
      ]);
      return emptyBody(204);
    });
  }

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    if (offline) {
      throw DioException(
        requestOptions: options,
        type: DioExceptionType.connectionError,
      );
    }
    final handler = routes['${options.method} ${options.uri.path}'];
    if (handler == null) {
      return finetError(404, 'not_found', 'Resursa nu a fost găsită.');
    }
    return handler(options);
  }

  @override
  void close({bool force = false}) {}
}
