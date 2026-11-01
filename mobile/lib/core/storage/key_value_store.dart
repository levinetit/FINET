import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Chei folosite în stocare. Tokenul de sesiune stă DOAR aici (Android Keystore), niciodată în
/// loguri, URL-uri sau analytics (promptul Android §6).
abstract final class StoreKeys {
  static const sessionToken = 'session_token';
  static const installationId = 'installation_id';
  static const introSeen = 'intro_seen';
  static const usageStats = 'usage_stats_enabled';
  static const appLock = 'app_lock_enabled';
  static const updateCache = 'update_cache';
  static const updateCheckedAt = 'update_checked_at';
}

/// Stocare cheie-valoare pentru secrete și setări mici. Implementarea reală folosește Android
/// Keystore; testele folosesc [MemoryKeyValueStore].
abstract class KeyValueStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class SecureKeyValueStore implements KeyValueStore {
  SecureKeyValueStore([FlutterSecureStorage? storage])
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

/// Stocare în memorie, pentru teste.
class MemoryKeyValueStore implements KeyValueStore {
  MemoryKeyValueStore([Map<String, String>? initial]) : values = {...?initial};

  final Map<String, String> values;

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}
