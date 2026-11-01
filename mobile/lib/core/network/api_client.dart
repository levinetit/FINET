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
    IdempotencyInterceptor(),
    RetryInterceptor(dio: dio, sleep: retrySleep),
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
