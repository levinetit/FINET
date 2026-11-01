import 'dart:async';

import 'package:dio/dio.dart';

import '../config/env.dart';
import 'api_error.dart';
import 'interceptors.dart';

/// Construiește clientul HTTP FINET: URL de bază din configurație, timeouturi, autentificare,
/// `Idempotency-Key` și reîncercări sigure (promptul Android §8, Faza A).
///
/// Ordinea interceptorilor contează: cheia de idempotență se pune înainte de reîncercare, ca
/// o reîncercare să trimită aceeași cheie.
Dio createApiClient(
  AppEnv env, {
  FutureOr<String?> Function()? tokenProvider,
  String Function()? clientHeader,
  void Function()? onUnauthorized,
  HttpClientAdapter? adapter,
  Future<void> Function(Duration)? retrySleep,
}) {
  final dio = Dio(
    BaseOptions(
      baseUrl: env.apiBaseUrl,
      connectTimeout: const Duration(seconds: 10),
      sendTimeout: const Duration(seconds: 30),
      receiveTimeout: const Duration(seconds: 30),
      // Redirecturile nu se urmează: un redirect către Cloudflare Access trebuie recunoscut.
      followRedirects: false,
      validateStatus: (status) =>
          status != null && status >= 200 && status < 300,
      headers: {'Accept': 'application/json'},
    ),
  );
  if (adapter != null) dio.httpClientAdapter = adapter;
  dio.interceptors.addAll([
    AuthInterceptor(tokenProvider ?? () => null),
    if (clientHeader != null) ClientHeaderInterceptor(clientHeader),
    IdempotencyInterceptor(),
    RetryInterceptor(dio: dio, sleep: retrySleep),
    if (onUnauthorized != null) UnauthorizedInterceptor(onUnauthorized),
  ]);
  return dio;
}

/// Execută o cerere și întoarce [ApiError] în loc de [DioException].
Future<T> guardApi<T>(Future<T> Function() request) async {
  try {
    return await request();
  } on DioException catch (e) {
    throw ApiError.fromDio(e);
  }
}

/// Citește un răspuns; orice abatere de la forma așteptată devine [ApiError] de server (nu o
/// excepție necontrolată în interfață).
T parseBody<T>(T Function() read) {
  try {
    return read();
  } on Object {
    throw const ApiError(
      kind: ApiErrorKind.server,
      message: 'Răspuns neașteptat de la server.',
    );
  }
}
