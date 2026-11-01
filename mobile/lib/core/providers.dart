import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../features/auth/auth_api.dart';
import '../features/auth/session.dart';
import '../features/settings/settings_controller.dart';
import '../features/usage/usage_tracker.dart';
import 'client/client_info.dart';
import 'config/env.dart';
import 'network/api_client.dart';
import 'storage/key_value_store.dart';

/// Furnizorii de bază. Cei care depind de platformă (stocare, date despre dispozitiv, configurație)
/// se suprascriu în `main()` și în teste.
final appEnvProvider = Provider<AppEnv>(
  (ref) => throw UnimplementedError('appEnvProvider'),
);

final keyValueStoreProvider = Provider<KeyValueStore>(
  (ref) => throw UnimplementedError('keyValueStoreProvider'),
);

final clientInfoProvider = Provider<ClientInfo>(
  (ref) => throw UnimplementedError('clientInfoProvider'),
);

/// Adaptor HTTP înlocuibil în teste (server simulat). În aplicație rămâne `null`.
final httpAdapterProvider = Provider<HttpClientAdapter?>((ref) => null);

/// Tokenul de sesiune în memorie; copia durabilă e în stocarea securizată.
class TokenHolder {
  String? value;
}

final tokenHolderProvider = Provider<TokenHolder>((ref) => TokenHolder());

final dioProvider = Provider<Dio>((ref) {
  final info = ref.watch(clientInfoProvider);
  return createApiClient(
    ref.watch(appEnvProvider),
    adapter: ref.watch(httpAdapterProvider),
    tokenProvider: () => ref.read(tokenHolderProvider).value,
    clientHeader: info.toHeader,
    // Citit leneș: sesiunea depinde de acest client.
    onUnauthorized: () => ref.read(sessionProvider.notifier).expire(),
  );
});

final authApiProvider = Provider<AuthApi>(
  (ref) => AuthApi(ref.watch(dioProvider)),
);

final usageTrackerProvider = Provider<UsageTracker>((ref) {
  final dio = ref.watch(dioProvider);
  return UsageTracker(
    enabled: ref.read(settingsProvider).usageStats,
    send: (events) async {
      await guardApi(
        () => dio.post<dynamic>('/api/v1/app/events', data: {'events': events}),
      );
    },
  );
});
