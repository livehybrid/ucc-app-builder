/**
 * Live preview of the UI that ucc-gen will generate from globalConfig.json.
 *
 * Renders the Configuration tabs, Inputs page and Alert forms with the same
 * component library the real UCC UI uses (@splunk/react-ui), and evaluates the
 * declared validators as the user types — so a regex or range mistake is
 * caught here, before a build is ever run. Entirely client-side; no cost.
 */
import { useMemo, useState } from 'react';
import styled from 'styled-components';
import TabLayout from '@splunk/react-ui/TabLayout';
import Table from '@splunk/react-ui/Table';
import Text from '@splunk/react-ui/Text';
import TextArea from '@splunk/react-ui/TextArea';
import Select from '@splunk/react-ui/Select';
import Multiselect from '@splunk/react-ui/Multiselect';
import ComboBox from '@splunk/react-ui/ComboBox';
import Switch from '@splunk/react-ui/Switch';
import RadioBar from '@splunk/react-ui/RadioBar';
import File from '@splunk/react-ui/File';
import Button from '@splunk/react-ui/Button';
import ControlGroup from '@splunk/react-ui/ControlGroup';
import Heading from '@splunk/react-ui/Heading';
import Message from '@splunk/react-ui/Message';
import Link from '@splunk/react-ui/Link';
import { variables } from '@splunk/themes';
import {
  buildPreviewModel,
  validateEntityValue,
  initialValues,
  PreviewEntity,
  PreviewModel,
} from '../lib/configPreview';

const Frame = styled.div`
  border: 1px solid ${variables.borderColor};
  border-radius: 8px;
  background: ${variables.backgroundColorPage};
  overflow: hidden;
`;

const AppBar = styled.div`
  padding: 14px 20px;
  border-bottom: 1px solid ${variables.borderColor};
  display: flex;
  align-items: baseline;
  gap: 12px;
  background: ${variables.backgroundColorNavigation};
`;

const Body = styled.div`
  padding: 16px 20px 24px 20px;
`;

/* The built app exposes Inputs/Configuration/Dashboard as views in the Splunk
 * app NAVIGATION BAR (default/data/ui/nav), not as tabs inside a page — mirror
 * that chrome so the preview reads like the real app. */
const NavBar = styled.div`
  display: flex;
  gap: 2px;
  padding: 0 12px;
  background: #1a1c20;
  border-bottom: 1px solid ${variables.borderColor};
`;

const NavItem = styled.button<{ $active: boolean }>`
  appearance: none;
  border: none;
  cursor: pointer;
  padding: 10px 14px;
  font-size: 13px;
  font-weight: ${(p) => (p.$active ? 600 : 400)};
  color: ${(p) => (p.$active ? '#ffffff' : 'rgba(255, 255, 255, 0.75)')};
  background: ${(p) => (p.$active ? 'rgba(255, 255, 255, 0.12)' : 'transparent')};
  border-bottom: 3px solid ${(p) => (p.$active ? '#5cc05c' : 'transparent')};
  &:hover {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.08);
  }
`;

const FormGrid = styled.div`
  max-width: 640px;
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const Muted = styled.span`
  color: ${variables.contentColorMuted};
  font-size: 0.85em;
`;

type OptionItem = { value: string; label: string };

function optionItems(entity: PreviewEntity): OptionItem[] {
  const raw =
    (entity.options?.autoCompleteFields as unknown[]) ?? (entity.options?.items as unknown[]) ?? [];
  const out: OptionItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (Array.isArray(rec.children)) {
      // Grouped options — flatten with the group prefix for the preview.
      for (const child of rec.children as Array<Record<string, unknown>>) {
        out.push({
          value: String(child.value ?? ''),
          label: `${String(rec.label ?? '')} / ${String(child.label ?? child.value ?? '')}`,
        });
      }
    } else {
      out.push({
        value: String(rec.value ?? ''),
        label: String(rec.label ?? rec.value ?? ''),
      });
    }
  }
  return out.filter((o) => o.value !== '');
}

/** One entity rendered as the built app would render it, with live validation. */
function EntityField({
  entity,
  value,
  onChange,
}: {
  entity: PreviewEntity;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const error = validateEntityValue(entity, entity.type === 'checkbox' ? '' : value);

  if (entity.type === 'helpLink') {
    const link = entity.options?.text as string | undefined;
    const url = entity.options?.link as string | undefined;
    return (
      <div style={{ margin: '4px 0' }}>
        <Link to={url ?? '#'} openInNewContext>
          {link ?? entity.label}
        </Link>
      </div>
    );
  }

  let control: React.ReactNode;
  switch (entity.type) {
    case 'textarea':
      control = (
        <TextArea
          value={String(value ?? '')}
          onChange={(_e: unknown, { value: v }: { value: string }) => onChange(v)}
          rowsMin={3}
        />
      );
      break;
    case 'singleSelect': {
      const items = optionItems(entity);
      const createSearch = Boolean(entity.options?.createSearchChoice);
      if (createSearch) {
        control = (
          <ComboBox
            value={String(value ?? '')}
            onChange={(_e: unknown, { value: v }: { value: string }) => onChange(v)}
            inline={false}
          >
            {items.map((o) => (
              <ComboBox.Option key={o.value} value={o.value} />
            ))}
          </ComboBox>
        );
      } else {
        control = (
          <Select
            value={(value as string) ?? ''}
            onChange={(_e: unknown, { value: v }: { value: string | number | boolean }) =>
              onChange(String(v))
            }
            filter={!entity.options?.disableSearch && items.length > 6}
          >
            {items.map((o) => (
              <Select.Option key={o.value} label={o.label} value={o.value} />
            ))}
          </Select>
        );
      }
      break;
    }
    case 'multipleSelect': {
      const items = optionItems(entity);
      const values = Array.isArray(value) ? (value as string[]) : [];
      control = (
        <Multiselect
          values={values}
          onChange={(_e: unknown, { values: v }: { values: (string | number | boolean)[] }) =>
            onChange(v.map(String))
          }
        >
          {items.map((o) => (
            <Multiselect.Option key={o.value} label={o.label} value={o.value} />
          ))}
        </Multiselect>
      );
      break;
    }
    case 'checkbox':
      control = (
        <Switch
          selected={Boolean(value)}
          onClick={() => onChange(!value)}
          appearance="checkbox"
          value={entity.field}
        >
          {entity.label}
        </Switch>
      );
      break;
    case 'radio':
    case 'radioBar': {
      const items = optionItems(entity);
      control = (
        <RadioBar
          value={String(value ?? items[0]?.value ?? '')}
          onChange={(_e: unknown, { value: v }: { value: string }) => onChange(v)}
        >
          {items.map((o) => (
            <RadioBar.Option key={o.value} label={o.label} value={o.value} />
          ))}
        </RadioBar>
      );
      break;
    }
    case 'file':
      control = <File help={String(entity.options?.supportedFileTypes ?? '')} />;
      break;
    case 'oauth':
      control = (
        <Message type="info">
          OAuth flow (
          {String((entity.options?.auth_type as string[] | undefined)?.join(', ') ?? 'oauth')}) —
          rendered fully at runtime in Splunk.
        </Message>
      );
      break;
    case 'index':
      control = (
        <ComboBox
          value={String(value ?? '')}
          onChange={(_e: unknown, { value: v }: { value: string }) => onChange(v)}
          placeholder="default"
        >
          {['main', 'summary', 'history'].map((ix) => (
            <ComboBox.Option key={ix} value={ix} />
          ))}
        </ComboBox>
      );
      break;
    case 'custom':
      control = <Message type="info">Custom component — rendered at runtime.</Message>;
      break;
    default:
      // text, interval, and anything unrecognized fall back to a text input.
      control = (
        <Text
          value={String(value ?? '')}
          onChange={(_e: unknown, { value: v }: { value: string }) => onChange(v)}
          type={entity.encrypted ? 'password' : 'text'}
        />
      );
  }

  const help =
    error ??
    entity.help ??
    (entity.type === 'index' ? 'Live index list at runtime — sample values shown.' : undefined);

  return (
    <ControlGroup
      label={entity.type === 'checkbox' ? '' : entity.label + (entity.required ? ' *' : '')}
      labelPosition="top"
      help={help}
      error={Boolean(error)}
      data-testid={`preview-field-${entity.field}`}
    >
      {control}
    </ControlGroup>
  );
}

/** A whole entity form (one tab / one input service / one alert). */
function EntityForm({
  entities,
  onValuesChange,
}: {
  entities: PreviewEntity[];
  onValuesChange?: (values: Record<string, unknown>) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(entities));
  return (
    <FormGrid>
      {entities.map((e) => (
        <EntityField
          key={e.field || e.label}
          entity={e}
          value={values[e.field]}
          onChange={(v) =>
            setValues((prev) => {
              const next = { ...prev, [e.field]: v };
              onValuesChange?.(next);
              return next;
            })
          }
        />
      ))}
    </FormGrid>
  );
}

interface PreviewInputRow {
  serviceTitle: string;
  values: Record<string, unknown>;
}

function InputsPage({ model }: { model: PreviewModel }) {
  const [creating, setCreating] = useState<string | null>(null);
  const [rows, setRows] = useState<PreviewInputRow[]>([]);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [draftError, setDraftError] = useState<string | null>(null);
  const service = model.inputServices.find((s) => s.name === creating);

  const openCreate = (name: string) => {
    const svc = model.inputServices.find((s) => s.name === name);
    setDraft(svc ? initialValues(svc.entity) : {});
    setDraftError(null);
    setCreating(name);
  };

  const handleAdd = () => {
    if (!service) return;
    for (const e of service.entity) {
      const err = validateEntityValue(e, draft[e.field]);
      if (err) {
        setDraftError(`${e.label || e.field}: ${err}`);
        return;
      }
    }
    setRows((prev) => [...prev, { serviceTitle: service.title, values: draft }]);
    setDraftError(null);
    setCreating(null);
  };

  if (!model.inputServices.length) {
    return <Message type="info">No inputs defined in globalConfig.json yet.</Message>;
  }

  const cell = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : String(v));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Heading level={3} style={{ margin: 0 }}>
          Inputs
        </Heading>
        {model.inputServices.length === 1 ? (
          <Button
            appearance="primary"
            label="Create New Input"
            style={{ flex: '0 0 auto', width: 'auto' }}
            onClick={() => openCreate(model.inputServices[0].name)}
          />
        ) : (
          <div style={{ flex: '0 0 auto' }}>
            <Select
              value={creating ?? ''}
              onChange={(_e: unknown, { value: v }: { value: string | number | boolean }) =>
                openCreate(String(v))
              }
              placeholder="Create New Input ▾"
            >
              {model.inputServices.map((s) => (
                <Select.Option key={s.name} label={s.title} value={s.name} />
              ))}
            </Select>
          </div>
        )}
      </div>

      {service ? (
        <div style={{ marginTop: 12 }}>
          <Heading level={4}>Add {service.title}</Heading>
          {service.description && <Muted>{service.description}</Muted>}
          <div style={{ marginTop: 8 }}>
            <EntityForm key={service.name} entities={service.entity} onValuesChange={setDraft} />
          </div>
          {draftError && (
            <Message type="error" style={{ marginTop: 8 }}>
              {draftError}
            </Message>
          )}
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <Button appearance="primary" label="Add" onClick={handleAdd} />
            <Button label="Cancel" onClick={() => setCreating(null)} />
          </div>
        </div>
      ) : (
        <Table stripeRows style={{ marginTop: 12 }}>
          <Table.Head>
            <Table.HeadCell>Name</Table.HeadCell>
            <Table.HeadCell>Input type</Table.HeadCell>
            <Table.HeadCell>Interval</Table.HeadCell>
            <Table.HeadCell>Index</Table.HeadCell>
            <Table.HeadCell>Status</Table.HeadCell>
            <Table.HeadCell>Actions</Table.HeadCell>
          </Table.Head>
          <Table.Body>
            {rows.length === 0 ? (
              <Table.Row>
                <Table.Cell colSpan={6}>
                  <Muted>
                    No inputs created — use “Create New Input” to preview each input form. Added
                    inputs appear here (preview only — not saved to the app).
                  </Muted>
                </Table.Cell>
              </Table.Row>
            ) : (
              rows.map((row, i) => (
                <Table.Row key={i}>
                  <Table.Cell>{cell(row.values.name)}</Table.Cell>
                  <Table.Cell>{row.serviceTitle}</Table.Cell>
                  <Table.Cell>{cell(row.values.interval)}</Table.Cell>
                  <Table.Cell>{cell(row.values.index)}</Table.Cell>
                  <Table.Cell>Enabled</Table.Cell>
                  <Table.Cell>
                    <Link onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}>
                      Delete
                    </Link>
                  </Table.Cell>
                </Table.Row>
              ))
            )}
          </Table.Body>
        </Table>
      )}
    </div>
  );
}

function ConfigurationPage({ model }: { model: PreviewModel }) {
  // The nav only shows Configuration when tabs exist, but guard anyway.
  if (!model.configurationTabs.length) {
    return <Message type="info">No configuration tabs defined in globalConfig.json yet.</Message>;
  }
  return (
    <TabLayout defaultActivePanelId={model.configurationTabs[0].name}>
      {model.configurationTabs.map((tab) => (
        <TabLayout.Panel key={tab.name} label={tab.title} panelId={tab.name}>
          <div style={{ paddingTop: 12 }}>
            {tab.table && (
              <Table stripeRows style={{ marginBottom: 16 }}>
                <Table.Head>
                  {tab.table.header.map((h) => (
                    <Table.HeadCell key={h.field}>{h.label}</Table.HeadCell>
                  ))}
                </Table.Head>
                <Table.Body>
                  <Table.Row>
                    <Table.Cell colSpan={tab.table.header.length}>
                      <Muted>Entries appear here — the form below is the “Add” dialog.</Muted>
                    </Table.Cell>
                  </Table.Row>
                </Table.Body>
              </Table>
            )}
            <EntityForm key={tab.name} entities={tab.entity} />
          </div>
        </TabLayout.Panel>
      ))}
    </TabLayout>
  );
}

function AlertsPage({ model }: { model: PreviewModel }) {
  return (
    <div>
      {model.alerts.map((a) => (
        <div key={a.name} style={{ marginBottom: 20 }}>
          <Heading level={4}>{a.label}</Heading>
          {a.description && <Muted>{a.description}</Muted>}
          <div style={{ marginTop: 8 }}>
            <EntityForm entities={a.entity} />
          </div>
        </div>
      ))}
    </div>
  );
}

type PreviewView = 'inputs' | 'configuration' | 'alerts' | 'dashboard';

/** Views the built app's nav bar would actually contain for this config. */
function availableViews(model: PreviewModel): Array<{ id: PreviewView; label: string }> {
  const views: Array<{ id: PreviewView; label: string }> = [];
  if (model.hasInputsPage) {
    views.push({ id: 'inputs', label: `Inputs (${model.inputServices.length})` });
  }
  if (model.hasConfigurationPage) {
    views.push({ id: 'configuration', label: 'Configuration' });
  }
  if (model.alerts.length > 0) {
    views.push({ id: 'alerts', label: `Alert Actions (${model.alerts.length})` });
  }
  if (model.hasDashboard) {
    views.push({ id: 'dashboard', label: 'Dashboard' });
  }
  return views;
}

export function ConfigPreview({ configJson }: { configJson: string | null }) {
  const result = useMemo(() => {
    if (!configJson) return { model: null as PreviewModel | null, error: null as string | null };
    try {
      return { model: buildPreviewModel(configJson), error: null };
    } catch (e) {
      return { model: null, error: (e as Error).message };
    }
  }, [configJson]);

  // null = "first available view" (App remounts this component per vfsVersion,
  // so no stale-view bookkeeping is needed when the config changes).
  const [view, setView] = useState<PreviewView | null>(null);

  if (!configJson) {
    return (
      <Message type="warning">
        No globalConfig.json found in the project — generate or import an app first.
      </Message>
    );
  }
  if (result.error || !result.model) {
    return <Message type="error">{result.error ?? 'Could not build preview.'}</Message>;
  }

  const model = result.model;
  const views = availableViews(model);
  const activeView: PreviewView | null =
    view && views.some((v) => v.id === view) ? view : (views[0]?.id ?? null);

  return (
    <div>
      <Message type="info" style={{ marginBottom: 12 }}>
        Preview of the UI <strong>ucc-gen</strong> will generate — fields, tabs and validators are
        live (type to test them). Data is not saved. The dark bar mirrors the built app&apos;s
        navigation (default/data/ui/nav).
      </Message>
      <Frame data-testid="config-preview">
        <AppBar>
          <Heading level={2} style={{ margin: 0 }}>
            {model.meta.displayName}
          </Heading>
          <Muted>
            v{model.meta.version || '0.0.0'}
            {model.meta.restRoot ? ` · restRoot: ${model.meta.restRoot}` : ''}
          </Muted>
        </AppBar>
        {views.length > 0 ? (
          <>
            <NavBar role="tablist">
              {views.map((v) => (
                <NavItem
                  key={v.id}
                  role="tab"
                  aria-selected={activeView === v.id}
                  $active={activeView === v.id}
                  onClick={() => setView(v.id)}
                >
                  {v.label}
                </NavItem>
              ))}
            </NavBar>
            <Body>
              {/* Hide (don't unmount) inactive views so typed values and
                  preview-created input rows survive switching views. */}
              {views.some((v) => v.id === 'inputs') && (
                <div style={{ display: activeView === 'inputs' ? undefined : 'none' }}>
                  <InputsPage model={model} />
                </div>
              )}
              {views.some((v) => v.id === 'configuration') && (
                <div style={{ display: activeView === 'configuration' ? undefined : 'none' }}>
                  <ConfigurationPage model={model} />
                </div>
              )}
              {views.some((v) => v.id === 'alerts') && (
                <div style={{ display: activeView === 'alerts' ? undefined : 'none' }}>
                  <AlertsPage model={model} />
                </div>
              )}
              {activeView === 'dashboard' && (
                <Message type="info">
                  Monitoring dashboard — generated by ucc-gen at build time.
                </Message>
              )}
            </Body>
          </>
        ) : (
          <Body>
            <Message type="info">
              No pages defined yet — add an inputs page, configuration tabs, alerts or a dashboard
              to globalConfig.json to preview them here.
            </Message>
          </Body>
        )}
      </Frame>
    </div>
  );
}
