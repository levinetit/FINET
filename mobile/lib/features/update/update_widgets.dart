import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/tokens.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../usage/usage_tracker.dart';
import 'update_controller.dart';

/// „Versiune nouă disponibilă": notele versiunii și butonul care deschide linkul de descărcare.
/// Aplicația nu instalează nimic singură; instalarea o confirmă utilizatorul în Android.
class UpdateBanner extends ConsumerWidget {
  const UpdateBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(updateControllerProvider);
    final controller = ref.read(updateControllerProvider.notifier);
    final info = state.info;
    if (info == null || !controller.bannerVisible) {
      return const SizedBox.shrink();
    }
    final c = context.finet;
    return Card(
      color: c.ok.withValues(alpha: 0.12),
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Semantics(
          container: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Versiune nouă disponibilă: ${info.versionName}',
                style: Theme.of(context).textTheme.titleSmall,
              ),
              if (info.notes.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(info.notes),
                ),
              OverflowBar(
                alignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: controller.dismiss,
                    child: const Text('Mai târziu'),
                  ),
                  FilledButton(
                    onPressed: controller.openDownload,
                    child: const Text('Descarcă'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Versiunea instalată nu mai e acceptată de server: nicio funcție financiară nu mai rulează
/// până la actualizare.
class UpdateRequiredScreen extends ConsumerWidget {
  const UpdateRequiredScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final info = ref.watch(updateControllerProvider).info;
    final controller = ref.read(updateControllerProvider.notifier);
    return FinetScaffold(
      title: 'Actualizare necesară',
      screen: UsageScreens.update,
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Această versiune a aplicației nu mai este acceptată de server. '
              'Instalează versiunea nouă pentru a continua.',
            ),
            if (info != null) ...[
              const SizedBox(height: 12),
              Text(
                'Versiunea ${info.versionName}',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              if (info.notes.isNotEmpty) Text(info.notes),
              const SizedBox(height: 8),
              Text(
                'Suma SHA-256 a fișierului: ${info.sha256}',
                style: TextStyle(color: context.finet.muted),
              ),
            ],
            const SizedBox(height: 16),
            FilledButton(
              onPressed: info == null ? null : controller.openDownload,
              child: const Text('Descarcă actualizarea'),
            ),
          ],
        ),
      ),
    );
  }
}
