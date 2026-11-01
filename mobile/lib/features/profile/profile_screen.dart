import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_error.dart';
import '../../core/providers.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../../core/widgets/states.dart';
import '../auth/models.dart';
import '../auth/session.dart';
import '../usage/usage_tracker.dart';

/// Gospodăriile utilizatorului (`GET /api/v1/households`). Se reîncarcă la fiecare deschidere.
final householdsProvider = FutureProvider.autoDispose<List<HouseholdInfo>>(
  (ref) => ref.watch(authApiProvider).households(),
);

/// Profilul: cine e conectat, gospodăriile, alegerea celei active și deconectarea.
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final text = Theme.of(context).textTheme;
    final muted = text.bodySmall?.copyWith(color: context.finet.muted);
    return FinetScaffold(
      title: 'Profil',
      mock: false,
      screen: UsageScreens.profile,
      body: session is! SignedIn
          ? const LoadingState()
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Card(
                  child: ListTile(
                    leading: const Icon(Icons.person_outline),
                    title: Text(session.profile.user.name),
                    subtitle: Text(session.profile.user.email),
                  ),
                ),
                const SizedBox(height: 20),
                Text('Gospodării', style: text.titleMedium),
                const SizedBox(height: 4),
                Text('Alege gospodăria în care lucrezi.', style: muted),
                const SizedBox(height: 8),
                const _Households(),
                const SizedBox(height: 24),
                OutlinedButton.icon(
                  onPressed: () => _confirmLogout(context, ref),
                  icon: const Icon(Icons.logout),
                  label: const Text('Deconectare'),
                ),
              ],
            ),
    );
  }

  Future<void> _confirmLogout(BuildContext context, WidgetRef ref) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Deconectare'),
        content: const Text(
          'Sesiunea de pe acest telefon se închide, iar datele locale se șterg. '
          'Datele tale rămân pe server.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Anulează'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Deconectează-mă'),
          ),
        ],
      ),
    );
    if (ok ?? false) await ref.read(sessionProvider.notifier).logout();
  }
}

class _Households extends ConsumerWidget {
  const _Households();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final households = ref.watch(householdsProvider);
    return households.when(
      loading: () =>
          const Padding(padding: EdgeInsets.all(24), child: LoadingState()),
      error: (e, _) => ErrorState(
        message: e is ApiError
            ? e.message
            : 'Gospodăriile nu au putut fi încărcate.',
        onRetry: () => ref.invalidate(householdsProvider),
      ),
      data: (list) {
        if (list.isEmpty) {
          return const EmptyState(title: 'Nu aparții niciunei gospodării');
        }
        return Card(
          child: RadioGroup<String>(
            groupValue: [
              for (final h in list)
                if (h.current) h.id,
            ].firstOrNull,
            onChanged: (id) => _switch(context, ref, id),
            child: Column(
              children: [
                for (final (i, h) in list.indexed) ...[
                  RadioListTile<String>(
                    value: h.id,
                    title: Text(h.name),
                    subtitle: Text(h.isOwner ? 'Proprietar' : 'Membru'),
                  ),
                  if (i != list.length - 1) const Divider(),
                ],
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _switch(BuildContext context, WidgetRef ref, String? id) async {
    if (id == null) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(sessionProvider.notifier).switchHousehold(id);
      ref.invalidate(householdsProvider);
    } on ApiError catch (e) {
      ref.read(usageTrackerProvider).error(e);
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }
}
