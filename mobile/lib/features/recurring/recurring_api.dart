import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../finance/models.dart';
import 'models.dart';

/// Apelurile pentru plățile recurente (Faza D). Toate aruncă `ApiError`.
class RecurringApi {
  RecurringApi(this._dio);

  final Dio _dio;

  Future<JsonMap> _body(Future<Response<dynamic>> Function() call) async {
    final r = await guardApi(call);
    return parseBody(() => Json.map(r.data));
  }

  Future<RecurringList> list({RecurringStatus? status}) async {
    final body = await _body(
      () => _dio.get<dynamic>(
        '/api/v1/recurring',
        queryParameters: {if (status != null) 'status': status.api},
      ),
    );
    return parseBody(
      () => RecurringList(
        rules: [
          for (final m in Json.list(body['data'])) RecurringRule.fromJson(m),
        ],
        counts: RecurringCounts.fromJson(Json.map(body['counts'])),
      ),
    );
  }

  Future<RecurringRule> pause(String id) => _rule(
    () => _dio.post<dynamic>('/api/v1/recurring/$id/pause', data: const {}),
  );

  Future<RecurringRule> resume(String id) => _rule(
    () => _dio.post<dynamic>('/api/v1/recurring/$id/resume', data: const {}),
  );

  Future<RecurringRule> _rule(Future<Response<dynamic>> Function() call) async {
    final body = await _body(call);
    return parseBody(() => RecurringRule.fromJson(Json.map(body['data'])));
  }

  /// „Generează acum”: cheia de idempotență e obligatorie pe server.
  Future<GenerateResult> generate({required String idempotencyKey}) async {
    final body = await _body(
      () => _dio.post<dynamic>(
        '/api/v1/recurring/generate',
        data: const {},
        options: Options(headers: {'Idempotency-Key': idempotencyKey}),
      ),
    );
    return parseBody(() => GenerateResult.fromJson(Json.map(body['data'])));
  }

  Future<List<RecurringSuggestion>> suggestions() async {
    final body = await _body(
      () => _dio.get<dynamic>('/api/v1/recurring/suggestions'),
    );
    return parseBody(
      () => [
        for (final m in Json.list(body['data']))
          RecurringSuggestion.fromJson(m),
      ],
    );
  }

  Future<void> acceptSuggestion(
    String signature, {
    required String idempotencyKey,
  }) async {
    await guardApi(
      () => _dio.post<dynamic>(
        '/api/v1/recurring/suggestions/${Uri.encodeComponent(signature)}/accept',
        data: const {},
        options: Options(headers: {'Idempotency-Key': idempotencyKey}),
      ),
    );
  }

  Future<void> dismissSuggestion(String signature) async {
    await guardApi(
      () => _dio.post<dynamic>(
        '/api/v1/recurring/suggestions/${Uri.encodeComponent(signature)}/dismiss',
        data: const {},
      ),
    );
  }
}
