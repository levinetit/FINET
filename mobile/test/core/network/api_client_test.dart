import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:finet_mobile/core/config/env.dart';
import 'package:finet_mobile/core/network/api_client.dart';
import 'package:finet_mobile/core/network/api_error.dart';
import 'package:flutter_test/flutter_test.dart';

/// Adaptor HTTP fals: răspunde din coadă și păstrează cererile primite.
class FakeAdapter implements HttpClientAdapter {
  FakeAdapter(this._steps);

  final List<Object> _steps; // ResponseBody sau DioException de aruncat
  final List<RequestOptions> requests = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    final step = _steps.length > requests.length - 1
        ? _steps[requests.length - 1]
        : _steps.last;
    if (step is DioException) {
      throw DioException(requestOptions: options, type: step.type);
    }
    return step as ResponseBody;
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody json(
  Object body, {
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

DioException netError([
  DioExceptionType type = DioExceptionType.connectionError,
]) => DioException(requestOptions: RequestOptions(), type: type);

const env = AppEnv(
  apiBaseUrl: 'https://finet.exemplu.test',
  useMockData: false,
);

Dio client(FakeAdapter adapter, {String? token}) => createApiClient(
  env,
  adapter: adapter,
  tokenProvider: () => token,
  retrySleep: (_) async {},
);

void main() {
  group('Idempotency-Key', () {
    test('POST primește o cheie UUID; GET nu', () async {
      final adapter = FakeAdapter([
        json({'ok': true}),
        json({'ok': true}),
      ]);
      final dio = client(adapter);
      await dio.post<dynamic>('/api/v1/transactions', data: {'a': 1});
      await dio.get<dynamic>('/api/v1/transactions');
      final key = adapter.requests[0].headers['Idempotency-Key'] as String;
      expect(
        key,
        matches(
          RegExp(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          ),
        ),
      );
      expect(
        adapter.requests[1].headers.containsKey('Idempotency-Key'),
        isFalse,
      );
    });

    test('două acțiuni diferite primesc chei diferite', () async {
      final adapter = FakeAdapter([json({}), json({})]);
      final dio = client(adapter);
      await dio.post<dynamic>('/x');
      await dio.post<dynamic>('/x');
      expect(
        adapter.requests[0].headers['Idempotency-Key'],
        isNot(adapter.requests[1].headers['Idempotency-Key']),
      );
    });

    test('cheia dată de apelant se păstrează', () async {
      final adapter = FakeAdapter([json({})]);
      await client(adapter).post<dynamic>(
        '/x',
        options: Options(headers: {'idempotency-key': 'cheia-mea-0123456789'}),
      );
      expect(
        adapter.requests.single.headers['idempotency-key'],
        'cheia-mea-0123456789',
      );
      // Antetele sunt insensibile la majuscule: există o singură cheie, cea a apelantului.
      expect(
        adapter.requests.single.headers.keys.where(
          (k) => k.toLowerCase() == 'idempotency-key',
        ),
        hasLength(1),
      );
    });
  });

  group('reîncercări', () {
    test('GET se reîncearcă după erori de rețea', () async {
      final adapter = FakeAdapter([
        netError(),
        netError(DioExceptionType.connectionTimeout),
        json({'ok': true}),
      ]);
      final res = await client(adapter).get<dynamic>('/x');
      expect(res.statusCode, 200);
      expect(adapter.requests, hasLength(3));
    });

    test('POST reîncercat trimite ACEEAȘI cheie de idempotență', () async {
      final adapter = FakeAdapter([
        netError(DioExceptionType.receiveTimeout),
        json({'ok': true}),
      ]);
      await client(adapter)
          .post<dynamic>('/api/v1/transactions', data: {'a': 1});
      expect(adapter.requests, hasLength(2));
      expect(adapter.requests[0].headers['Idempotency-Key'], isNotNull);
      expect(
        adapter.requests[1].headers['Idempotency-Key'],
        adapter.requests[0].headers['Idempotency-Key'],
      );
    });

    test('renunță după 2 reîncercări (3 cereri) și întoarce eroarea', () async {
      final adapter = FakeAdapter([netError()]);
      await expectLater(
        client(adapter).get<dynamic>('/x'),
        throwsA(
          isA<DioException>().having(
            (e) => e.type,
            'type',
            DioExceptionType.connectionError,
          ),
        ),
      );
      expect(adapter.requests, hasLength(3));
    });

    test('un răspuns de eroare al serverului nu se reîncearcă', () async {
      final adapter = FakeAdapter([
        json({
          'error': {'code': 'boom', 'message': 'x'},
        }, status: 500),
      ]);
      await expectLater(
        client(adapter).get<dynamic>('/x'),
        throwsA(isA<DioException>()),
      );
      expect(adapter.requests, hasLength(1));
    });

    test('PATCH (neidempotent, fără cheie) nu se reîncearcă', () async {
      final adapter = FakeAdapter([netError()]);
      await expectLater(
        client(adapter).patch<dynamic>('/x', data: {}),
        throwsA(isA<DioException>()),
      );
      expect(adapter.requests, hasLength(1));
    });
  });

  group('autentificare', () {
    test('adaugă Bearer când există token', () async {
      final adapter = FakeAdapter([json({})]);
      await client(adapter, token: 'tokenFictiv.semnatura').get<dynamic>('/x');
      expect(
        adapter.requests.single.headers['Authorization'],
        'Bearer tokenFictiv.semnatura',
      );
    });

    test('fără token nu trimite antetul', () async {
      final adapter = FakeAdapter([json({})]);
      await client(adapter).get<dynamic>('/x');
      expect(
        adapter.requests.single.headers.containsKey('Authorization'),
        isFalse,
      );
    });
  });

  group('ApiError', () {
    Future<ApiError> errorOf(ResponseBody body) async {
      try {
        await guardApi(() => client(FakeAdapter([body])).get<dynamic>('/x'));
      } on ApiError catch (e) {
        return e;
      }
      throw StateError('trebuia să eșueze');
    }

    test('401 → unauthorized', () async {
      final e = await errorOf(
        json({
          'error': {'code': 'unauthorized', 'message': 'Sesiune invalidă'},
        }, status: 401),
      );
      expect(e.kind, ApiErrorKind.unauthorized);
      expect(e.code, 'unauthorized');
      expect(e.status, 401);
    });

    test('403 JSON FINET → forbidden (nu accessWall)', () async {
      final e = await errorOf(
        json({
          'error': {'code': 'forbidden', 'message': 'Nu ai dreptul'},
        }, status: 403),
      );
      expect(e.kind, ApiErrorKind.forbidden);
      expect(e.message, 'Nu ai dreptul');
    });

    test('402 → subscriptionRequired', () async {
      final e = await errorOf(
        json({
          'error': {'code': 'subscription_required', 'message': 'x'},
        }, status: 402),
      );
      expect(e.kind, ApiErrorKind.subscriptionRequired);
    });

    test('400 cu câmpuri → client, cu fields', () async {
      final e = await errorOf(
        json({
          'error': {
            'code': 'validation',
            'message': 'Date invalide',
            'fields': {'amount': 'Prea mare'},
          },
        }, status: 400),
      );
      expect(e.kind, ApiErrorKind.client);
      expect(e.fields, {'amount': 'Prea mare'});
      expect(e.analyticsCode, 'validation_failed');
    });

    test('500 fără corp JSON → server, cu mesaj implicit', () async {
      final e = await errorOf(ResponseBody.fromString('oops', 500));
      expect(e.kind, ApiErrorKind.server);
      expect(e.message, isNotEmpty);
    });

    test('redirect către cloudflareaccess.com → accessWall', () async {
      final e = await errorOf(
        ResponseBody.fromString(
          '',
          302,
          headers: {
            'location': [
              'https://echipa.cloudflareaccess.com/cdn-cgi/access/login/finet',
            ],
          },
        ),
      );
      expect(e.kind, ApiErrorKind.accessWall);
      expect(e.message, ApiError.accessWallMessage);
    });

    test('403 HTML de la Cloudflare → accessWall', () async {
      final e = await errorOf(
        ResponseBody.fromString(
          '<html>Forbidden</html>',
          403,
          headers: {
            Headers.contentTypeHeader: ['text/html; charset=utf-8'],
            'server': ['cloudflare'],
          },
        ),
      );
      expect(e.kind, ApiErrorKind.accessWall);
    });

    test('analyticsCode nu conține mesajul', () async {
      final e = await errorOf(
        json({
          'error': {'code': 'x', 'message': 'Sumă 100 lei la Magazin'},
        }, status: 400),
      );
      expect(e.analyticsCode, isNot(contains('lei')));
    });

    test('erori de rețea', () async {
      final adapter = FakeAdapter([
        netError(DioExceptionType.connectionTimeout),
      ]);
      try {
        await guardApi(() => client(adapter).get<dynamic>('/x'));
        fail('trebuia să eșueze');
      } on ApiError catch (e) {
        expect(e.kind, ApiErrorKind.timeout);
        expect(e.analyticsCode, 'network_timeout');
      }
    });
  });
}
