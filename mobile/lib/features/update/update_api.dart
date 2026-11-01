import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_error.dart';
import '../../core/providers.dart';
import '../finance/models.dart';
import 'update_info.dart';

class UpdateApi {
  UpdateApi(this._dio);

  final Dio _dio;

  /// Ultima versiune publicată; `null` când serverul nu are niciuna (`404`).
  Future<UpdateInfo?> latest() async {
    try {
      final r = await guardApi(
        () => _dio.get<dynamic>('/api/v1/app/android/latest'),
      );
      final info = parseBody(
        () => UpdateInfo.fromJson(Json.map(Json.map(r.data)['data'])),
      );
      return info;
    } on ApiError catch (e) {
      if (e.status == 404) return null;
      rethrow;
    }
  }
}

final updateApiProvider = Provider<UpdateApi>(
  (ref) => UpdateApi(ref.watch(dioProvider)),
);
