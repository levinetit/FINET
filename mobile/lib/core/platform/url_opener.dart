import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

/// Deschide un link în afara aplicației (browser, aplicația Cloudflare One). Înlocuibil în teste.
typedef UrlOpener = Future<bool> Function(Uri uri);

final urlOpenerProvider = Provider<UrlOpener>(
  (_) =>
      (uri) => launchUrl(uri, mode: LaunchMode.externalApplication),
);
