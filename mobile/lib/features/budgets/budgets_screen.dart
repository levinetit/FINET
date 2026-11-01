import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../core/money/format.dart';
import '../../core/money/money.dart';
import '../../core/money/parse_amount.dart';
import '../../core/network/api_error.dart';
import '../../core/state/privacy.dart';
import '../../core/providers.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/amount_text.dart';
import '../../core/widgets/async_view.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../../core/widgets/month_selector.dart';
import '../../core/widgets/states.dart';
import '../finance/models.dart';
import '../finance/providers.dart';
import '../usage/usage_tracker.dart';

/// Bugete și obiective. Bugetele arată semaforul calculat de server (verde, galben, roșu) și cât a
/// rămas; obiectivele arată progresul și permit o contribuție sau o retragere.
class BudgetsScreen extends StatelessWidget {
  const BudgetsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: FinetScaffold(
        title: 'Bugete și obiective',
        screen: UsageScreens.budgets,
        body: const Column(
          children: [
            TabBar(
              tabs: [
                Tab(text: 'Bugete'),
                Tab(text: 'Obiective'),
              ],
            ),
            Expanded(child: TabBarView(children: [_BudgetsTab(), _GoalsTab()])),
          ],
        ),
      ),
    );
  }
}

Color _lightColor(BuildContext context, BudgetLight light) {
  final c = context.finet;
  return switch (light) {
    BudgetLight.green => c.ok,
    BudgetLight.yellow => c.warn,
    BudgetLight.red => c.bad,
  };
}

class _BudgetsTab extends ConsumerWidget {
  const _BudgetsTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final month = ref.watch(selectedMonthProvider);
    final budgets = ref.watch(budgetsProvider(month));
    final categories =
        ref.watch(categoriesProvider).asData?.value ?? const <Category>[];
    final names = {for (final c in categories) c.id: c.name};
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const MonthSelector(),
        AsyncView<BudgetsStatus>(
          value: budgets,
          onRetry: () => ref.invalidate(budgetsProvider),
          data: (b) {
            if (b.items.isEmpty) {
              return const EmptyState(
                title: 'Nu ai bugete pentru această lună',
                message: 'Creează un buget din aplicația web.',
              );
            }
            return Column(
              children: [
                for (final item in b.items)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: _BudgetCard(
                      item: item,
                      name: names[item.categoryId] ?? 'General',
                    ),
                  ),
              ],
            );
          },
        ),
      ],
    );
  }
}

class _BudgetCard extends ConsumerWidget {
  const _BudgetCard({required this.item, required this.name});
  final BudgetStatusItem item;
  final String name;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hidden = ref.watch(hideAmountsProvider);
    final text = Theme.of(context).textTheme;
    final color = _lightColor(context, item.status);
    Money m(int minor) => Money(minor, item.currency);
    final remaining = item.remainingMinor < 0
        ? 'Depășit cu ${displayMoney(m(-item.remainingMinor), hidden: hidden)}'
        : 'Rămas ${displayMoney(m(item.remainingMinor), hidden: hidden)}';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(name, style: text.titleSmall)),
                // Starea e și text, nu doar culoare (accesibilitate).
                Text(
                  item.status.label,
                  style: text.labelMedium?.copyWith(color: color),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Semantics(
              label: '${item.percent}% din buget, ${item.status.label}',
              child: ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(
                  value: (item.percent / 100).clamp(0.0, 1.0),
                  minHeight: 8,
                  backgroundColor: context.finet.line,
                  color: color,
                ),
              ),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 4,
              runSpacing: 2,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                AmountText(m(item.spentMinor), size: 14),
                Text('din', style: text.bodySmall),
                AmountText(m(item.amountMinor), size: 14),
                Text('· ${item.percent}%', style: text.bodySmall),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              remaining,
              style: text.bodySmall?.copyWith(color: context.finet.muted),
            ),
          ],
        ),
      ),
    );
  }
}

class _GoalsTab extends ConsumerWidget {
  const _GoalsTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final goals = ref.watch(goalsProvider);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        AsyncView<List<Goal>>(
          value: goals,
          onRetry: () => ref.invalidate(goalsProvider),
          data: (list) {
            if (list.isEmpty) {
              return const EmptyState(
                title: 'Nu ai obiective de economisire',
                message: 'Creează un obiectiv din aplicația web.',
              );
            }
            return Column(
              children: [
                for (final g in list)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: _GoalCard(goal: g),
                  ),
              ],
            );
          },
        ),
      ],
    );
  }
}

class _GoalCard extends ConsumerWidget {
  const _GoalCard({required this.goal});
  final Goal goal;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final text = Theme.of(context).textTheme;
    final c = context.finet;
    Money m(int minor) => Money(minor, goal.currency);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(goal.name, style: text.titleSmall)),
                Text(
                  goal.status.label,
                  style: text.labelMedium?.copyWith(color: c.muted),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Semantics(
              label: '${goal.progressPct}% din obiectiv',
              child: ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(
                  value: (goal.progressPct / 100).clamp(0.0, 1.0),
                  minHeight: 8,
                  backgroundColor: c.line,
                  color: goal.status == GoalStatus.achieved ? c.ok : c.accent,
                ),
              ),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 4,
              runSpacing: 2,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                AmountText(m(goal.savedMinor), size: 14),
                Text('din', style: text.bodySmall),
                AmountText(m(goal.targetMinor), size: 14),
                Text('· ${goal.progressPct}%', style: text.bodySmall),
              ],
            ),
            if (goal.deadline != null) ...[
              const SizedBox(height: 4),
              Text(
                'Termen: ${formatDate(goal.deadline!)}',
                style: text.bodySmall?.copyWith(color: c.muted),
              ),
            ],
            if (goal.status == GoalStatus.active) ...[
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: OutlinedButton(
                  onPressed: () => showDialog<void>(
                    context: context,
                    builder: (_) => _ContributionDialog(goal: goal),
                  ),
                  child: const Text('Contribuție'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Contribuție sau retragere dintr-un obiectiv. Cheia de idempotență e OBLIGATORIE pe server și se
/// generează o singură dată per dialog, ca un dublu-tap să nu dubleze suma economisită.
class _ContributionDialog extends ConsumerStatefulWidget {
  const _ContributionDialog({required this.goal});
  final Goal goal;

  @override
  ConsumerState<_ContributionDialog> createState() =>
      _ContributionDialogState();
}

class _ContributionDialogState extends ConsumerState<_ContributionDialog> {
  final _form = GlobalKey<FormState>();
  final _amount = TextEditingController();
  final String _key = const Uuid().v4();
  bool _add = true;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy || !(_form.currentState?.validate() ?? false)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(financeApiProvider)
          .goalContribution(
            widget.goal.id,
            add: _add,
            amount: parseAmount(_amount.text, widget.goal.currency),
            idempotencyKey: _key,
          );
      ref.read(usageTrackerProvider).track(UsageEvents.goalContributionAdded);
      invalidateFinance(ref.invalidate);
      if (mounted) Navigator.pop(context);
    } on ApiError catch (e) {
      ref.read(usageTrackerProvider).error(e);
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.goal.name),
      content: Form(
        key: _form,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            SegmentedButton<bool>(
              segments: const [
                ButtonSegment(value: true, label: Text('Adaugă')),
                ButtonSegment(value: false, label: Text('Retrage')),
              ],
              selected: {_add},
              onSelectionChanged: _busy
                  ? null
                  : (s) => setState(() => _add = s.first),
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _amount,
              enabled: !_busy,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              decoration: InputDecoration(
                labelText: 'Suma',
                suffixText: widget.goal.currency.symbol,
                border: const OutlineInputBorder(),
              ),
              validator: (v) {
                try {
                  if (parseAmount(v ?? '', widget.goal.currency).isZero) {
                    return 'Suma trebuie să fie mai mare ca zero.';
                  }
                } on InvalidAmountException catch (e) {
                  return e.message;
                }
                return null;
              },
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(
                _error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: const Text('Anulează'),
        ),
        FilledButton(
          onPressed: _busy ? null : _submit,
          child: const Text('Salvează'),
        ),
      ],
    );
  }
}
