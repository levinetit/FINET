import 'dart:async';
import 'dart:math';

import 'package:dio/dio.dart';
import 'package:uuid/uuid.dart';

/// Antet cu tokenul de sesiune (`Authorization: Bearer …`). Tokenul nu apare niciodată în loguri.
/// În Faza A nu există sesiune: [tokenProvider] întoarce `null`.
class AuthInterceptor extends Interceptor {
  AuthInterceptor(this.tokenProvider);

  final FutureOr<String?> Function() tokenProvider;

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    final token = await tokenProvider();
    if (token != null && token.isNotEmpty) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    handler.next(options);
  }
}

/// Antetul `X-FINET-Client` pe fiecare cerere (versiune, Android, model, instalare). Serverul
/// înregistrează instalarea doar cu consimțământul de statistici; antetul în sine nu conține nimic
/// financiar.
class ClientHeaderInterceptor extends Interceptor {
  ClientHeaderInterceptor(this.headerValue);

  final String Function() headerValue;

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    options.headers['X-FINET-Client'] = headerValue();
    handler.next(options);
  }
}

/// 401 pe o cerere cu token = sesiune expirată sau revocată: apelează [onUnauthorized] o dată
/// (sesiunea șterge datele locale și duce la login). Cererile fără token (de exemplu loginul
/// însuși) nu declanșează nimic.
class UnauthorizedInterceptor extends Interceptor {
  UnauthorizedInterceptor(this.onUnauthorized);

  final void Function() onUnauthorized;

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    final hadToken = err.requestOptions.headers.containsKey('Authorization');
    if (err.response?.statusCode == 401 && hadToken) onUnauthorized();
    handler.next(err);
  }
}

/// `Idempotency-Key` pe fiecare `POST` (promptul Android §7): UUID generat o singură dată per
/// acțiune. Cheia stă în `options.headers`, deci o reîncercare automată a aceleiași cereri o
/// refolosește; o acțiune nouă a utilizatorului primește o cheie nouă.
class IdempotencyInterceptor extends Interceptor {
  IdempotencyInterceptor({Uuid? uuid}) : _uuid = uuid ?? const Uuid();

  final Uuid _uuid;

  static const String header = 'Idempotency-Key';

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    if (options.method.toUpperCase() == 'POST' && !_hasHeader(options)) {
      options.headers[header] = _uuid.v4();
    }
    handler.next(options);
  }

  static bool _hasHeader(RequestOptions o) =>
      o.headers.keys.any((k) => k.toLowerCase() == header.toLowerCase());
}

/// Reîncercări DOAR pentru erori de rețea (fără răspuns de la server) și DOAR pentru cereri
/// idempotente: `GET`, `HEAD`, `PUT`, `DELETE` sau `POST` cu `Idempotency-Key`. Un răspuns de
/// eroare al serverului (4xx/5xx) nu se reîncearcă niciodată.
class RetryInterceptor extends Interceptor {
  RetryInterceptor({
    required this.dio,
    this.maxRetries = 2,
    this.baseDelay = const Duration(milliseconds: 400),
    Future<void> Function(Duration)? sleep,
  }) : _sleep = sleep ?? Future<void>.delayed;

  final Dio dio;
  final int maxRetries;
  final Duration baseDelay;
  final Future<void> Function(Duration) _sleep;

  static const String _attemptKey = 'finet_retry_attempt';

  /// Cererile cu corp `FormData` (încărcări) nu se pot trimite a doua oară: fluxul e consumat.
  /// Ele pun `extra[noRetryKey] = true`, iar apelantul reconstruiește corpul din aceiași octeți.
  static const String noRetryKey = 'finet_no_retry';

  static const _networkTypes = {
    DioExceptionType.connectionTimeout,
    DioExceptionType.sendTimeout,
    DioExceptionType.receiveTimeout,
    DioExceptionType.connectionError,
  };

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    final options = err.requestOptions;
    final attempt = (options.extra[_attemptKey] as int?) ?? 0;
    if (options.extra[noRetryKey] == true ||
        !_networkTypes.contains(err.type) ||
        attempt >= maxRetries ||
        !_isSafeToRepeat(options)) {
      return handler.next(err);
    }
    options.extra[_attemptKey] = attempt + 1;
    await _sleep(baseDelay * pow(2, attempt).toInt());
    try {
      final response = await dio.fetch<dynamic>(options);
      handler.resolve(response);
    } on DioException catch (e) {
      handler.next(e);
    }
  }

  static bool _isSafeToRepeat(RequestOptions o) {
    switch (o.method.toUpperCase()) {
      case 'GET':
      case 'HEAD':
      case 'PUT':
      case 'DELETE':
        return true;
      case 'POST':
        return o.headers.keys.any(
          (k) => k.toLowerCase() == IdempotencyInterceptor.header.toLowerCase(),
        );
      default:
        return false;
    }
  }
}
