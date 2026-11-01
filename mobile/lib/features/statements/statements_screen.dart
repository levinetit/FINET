import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/money/format.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/async_view.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../usage/usage_tracker.dart';
import 'models.dart';
import 'providers.dart';

/// Extrase bancare: acoperirea pe luni a fiecărui cont și importurile recente.
class StatementsScreen extends ConsumerWidget {
  const StatementsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final coverage = ref.watch(coverageProvider);
    final imports = ref.watch(importsProvider);
    return FinetScaffold(
      title: 'Extrase bancare',
      screen: UsageScreens.statements,
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(coverageProvider);
          ref.invalidate(importsProvider);
          await ref.read(coverageProvider.future);
        },
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            FilledButton.icon(
              onPressed: () => context.push('/statements/import'),
              icon: const Icon(Icons.upload_file),
              label: const Text('Importă un extras'),
            ),
            const SizedBox(height: 16),
            Text(
              'Acoperire extrase',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            AsyncView<List<AccountCoverage>>(
              value: coverage,
              onRetry: () => ref.invalidate(coverageProvider),
              data: (accounts) => accounts.isEmpty
                  ? const Padding(
                      padding: EdgeInsets.all(8),
                      child: Text('Nu ai conturi bancare.'),
                    )
                  : Column(
                      children: [
                        for (final a in accounts) _CoverageCard(account: a),
                      ],
                    ),
            ),
            const SizedBox(height: 16),
            Text(
              'Importuri recente',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            AsyncView<List<StatementImport>>(
              value: imports,
              onRetry: () => ref.invalidate(importsProvider),
              data: (items) => items.isEmpty
                  ? const Padding(
                      padding: EdgeInsets.all(8),
                      child: Text('Niciun extras importat încă.'),
                    )
                  : Column(
                      children: [
                        for (final i in items)
                          Card(
                            child: ListTile(
                              title: Text(
                                '${i.bank.toUpperCase()} · ${i.format.toUpperCase()}',
                              ),
                              subtitle: Text(
                                '${_period(i)} · ${i.status.label} · ${i.lineCount} rânduri',
                              ),
                              onTap: () => context.push('/statements/${i.id}'),
                            ),
                          ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }

  static String _period(StatementImport i) {
    final a = i.periodStart;
    final b = i.periodEnd;
    return a == null || b == null
        ? 'fără perioadă'
        : '${formatDate(a)} – ${formatDate(b)}';
  }
}

/// „2026-09” → „09.2026”.
String monthLabel(String month) {
  final p = month.split('-');
  return p.length == 2 ? '${p[1]}.${p[0]}' : month;
}

class _CoverageCard extends StatelessWidget {
  const _CoverageCard({required this.account});

  final AccountCoverage account;

  @override
  Widget build(BuildContext context) {
    final c = context.finet;
    return Card(
      margin: const EdgeInsets.only(top: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${account.accountName} (${account.currency.code})',
              style: Theme.of(context).textTheme.titleSmall,
            ),
            if (account.missingMonths.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  'Contul „${account.accountName}” nu are extras pentru: '
                  '${account.missingMonths.map(monthLabel).join(', ')}.',
                  style: TextStyle(color: c.warn),
                ),
              ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final m in account.months)
                  Chip(
                    label: Text('${monthLabel(m.month)}: ${_status(m)}'),
                    visualDensity: VisualDensity.compact,
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  static String _status(CoverageMonth m) => switch (m.status) {
    'complete' => 'Complet',
    'partial' =>
      m.coveredUntil == null
          ? 'Parțial'
          : 'Parțial, până la ${formatDate(m.coveredUntil!)}',
    _ => 'Lipsă',
  };
}
