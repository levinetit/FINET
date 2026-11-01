import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import '../../core/router.dart';
import '../auth/session.dart';
import '../lock/app_lock.dart';
import '../scan/media.dart';
import '../scan/scan_controller.dart';
import '../usage/usage_tracker.dart';
import 'share_source.dart';

/// Primește fișierele partajate din alte aplicații și deschide importul potrivit, dar numai după
/// autentificare și deblocare: până atunci fișierele așteaptă în [pendingShareProvider].
///
/// - poze → ecranul „Scanează" (cu pozele puse deja în listă);
/// - CSV sau XLSX → importul de extras;
/// - un PDF → alegerea dintre bon și extras (serverul nu poate ghici din partea telefonului).
class ShareCoordinator extends ConsumerStatefulWidget {
  const ShareCoordinator({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<ShareCoordinator> createState() => _ShareCoordinatorState();
}

class _ShareCoordinatorState extends ConsumerState<ShareCoordinator> {
  @override
  void initState() {
    super.initState();
    final source = ref.read(shareSourceProvider);
    final pending = ref.read(pendingShareProvider.notifier);
    source.listen((files) {
      pending.add(files);
      _maybeHandle();
    });
    source.takeInitial().then((files) {
      pending.add(files);
      _maybeHandle();
    });
  }

  bool get _ready =>
      ref.read(sessionProvider) is SignedIn && !ref.read(lockedProvider);

  void _maybeHandle() {
    if (!mounted || !_ready) return;
    if (ref.read(pendingShareProvider).isEmpty) return;
    final files = ref.read(pendingShareProvider.notifier).take();
    ref.read(usageTrackerProvider).track(UsageEvents.shareImport);
    final router = ref.read(routerProvider);
    final allImages = files.every((f) => f.kind == MediaKind.image);
    if (allImages) {
      ref.read(scanControllerProvider.notifier).addShared(files);
      router.go('/scan');
    } else if (files.length == 1 && files.single.kind == MediaKind.pdf) {
      router.push('/share/pdf', extra: files.single);
    } else if (files.length == 1 &&
        (files.single.kind == MediaKind.csv ||
            files.single.kind == MediaKind.spreadsheet)) {
      router.push('/statements/import', extra: files.single);
    } else {
      router.push('/share/unsupported');
    }
  }

  @override
  Widget build(BuildContext context) {
    // Autentificarea sau deblocarea reia partajarea rămasă în așteptare.
    ref.listen(sessionProvider, (_, _) => _maybeHandle());
    ref.listen(lockedProvider, (_, _) => _maybeHandle());
    ref.listen(pendingShareProvider, (_, _) => _maybeHandle());
    return widget.child;
  }
}
