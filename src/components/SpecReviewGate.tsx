/**
 * SpecReviewGate — the human review gate between Expert Expansion and the build.
 *
 * The agent's biggest failure mode is building a thin add-on (one input, no auth, no CIM).
 * Expansion (src/lib/ai/expansion.ts) proposes a COMPLETE UccSpec; this component lets the
 * user inspect and edit it — inputs, fields, auth, proxy/logging, sourcetypes, CIM — then
 * confirm. The approved spec seeds whichever agent path actually builds it. Editable and
 * grounded beats a black box.
 */
import { useMemo, useState } from 'react';
import styled from 'styled-components';
import { variables } from '@splunk/themes';
import Button from '@splunk/react-ui/Button';
import Text from '@splunk/react-ui/Text';
import Select from '@splunk/react-ui/Select';
import Switch from '@splunk/react-ui/Switch';
import Heading from '@splunk/react-ui/Heading';
import Message from '@splunk/react-ui/Message';
import {
  type UccSpec,
  type UccSpecInput,
  type UccSpecField,
  type UccAuthType,
  type UccCollection,
  type UccFieldType,
  specWarnings,
} from '../lib/ai/expansion';

const Wrap = styled.div`
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 20px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
`;

const Card = styled.div`
  border: 1px solid ${variables.borderColor};
  border-radius: 6px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.02);
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const Row = styled.div`
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: flex-end;
`;

const FieldLabel = styled.label`
  font-size: 0.75rem;
  color: #9b9ea3;
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 120px;
`;

const SectionTitle = styled(Heading)`
  margin: 0;
`;

const Tag = styled.span<{ $ok?: boolean }>`
  font-size: 0.7rem;
  padding: 2px 8px;
  border-radius: 10px;
  background: ${(p) => (p.$ok ? 'rgba(101,166,55,0.25)' : 'rgba(255,255,255,0.08)')};
  color: ${(p) => (p.$ok ? '#8bc34a' : '#c3c5c9')};
`;

const Footer = styled.div`
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 12px 20px;
  border-top: 1px solid ${variables.borderColor};
  flex-shrink: 0;
`;

const AUTH_TYPES: UccAuthType[] = ['none', 'api_key', 'bearer_token', 'basic', 'oauth2'];
const COLLECTIONS: UccCollection[] = ['rest_api', 'modular_input', 'file_monitor', 'scripted'];
const FIELD_TYPES: UccFieldType[] = ['text', 'password', 'checkbox', 'singleSelect', 'number'];

interface Props {
  spec: UccSpec;
  onBuild: (spec: UccSpec) => void;
  onCancel: () => void;
  busy?: boolean;
}

export function SpecReviewGate({ spec, onBuild, onCancel, busy }: Props) {
  const [draft, setDraft] = useState<UccSpec>(spec);
  const warnings = useMemo(() => specWarnings(draft), [draft]);

  const top = (patch: Partial<UccSpec>) => setDraft((p) => ({ ...p, ...patch }));
  const setAccount = (patch: Partial<UccSpec['account']>) =>
    setDraft((p) => ({ ...p, account: { ...p.account, ...patch } }));

  const setAccountField = (i: number, patch: Partial<UccSpecField>) =>
    setDraft((p) => ({
      ...p,
      account: {
        ...p.account,
        fields: p.account.fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)),
      },
    }));
  const addAccountField = () =>
    setDraft((p) => ({
      ...p,
      account: { ...p.account, fields: [...p.account.fields, { name: '', type: 'text' }] },
    }));
  const removeAccountField = (i: number) =>
    setDraft((p) => ({
      ...p,
      account: { ...p.account, fields: p.account.fields.filter((_, idx) => idx !== i) },
    }));

  const setInput = (i: number, patch: Partial<UccSpecInput>) =>
    setDraft((p) => ({
      ...p,
      inputs: p.inputs.map((inp, idx) => (idx === i ? { ...inp, ...patch } : inp)),
    }));
  const addInput = () =>
    setDraft((p) => ({
      ...p,
      inputs: [...p.inputs, { name: '', collection: 'rest_api', fields: [] }],
    }));
  const removeInput = (i: number) =>
    setDraft((p) => ({ ...p, inputs: p.inputs.filter((_, idx) => idx !== i) }));

  const setInputField = (ii: number, fi: number, patch: Partial<UccSpecField>) =>
    setDraft((p) => ({
      ...p,
      inputs: p.inputs.map((inp, idx) =>
        idx !== ii
          ? inp
          : { ...inp, fields: inp.fields.map((f, j) => (j === fi ? { ...f, ...patch } : f)) }
      ),
    }));
  const addInputField = (ii: number) =>
    setDraft((p) => ({
      ...p,
      inputs: p.inputs.map((inp, idx) =>
        idx !== ii ? inp : { ...inp, fields: [...inp.fields, { name: '', type: 'text' }] }
      ),
    }));
  const removeInputField = (ii: number, fi: number) =>
    setDraft((p) => ({
      ...p,
      inputs: p.inputs.map((inp, idx) =>
        idx !== ii ? inp : { ...inp, fields: inp.fields.filter((_, j) => j !== fi) }
      ),
    }));

  const txt = (value: string | number | undefined, onChange: (v: string) => void, ph?: string) => (
    <Text
      value={value === undefined ? '' : String(value)}
      onChange={(_e: unknown, d: { value: string }) => onChange(d.value)}
      placeholder={ph}
    />
  );

  const renderFieldRow = (
    f: UccSpecField,
    onPatch: (patch: Partial<UccSpecField>) => void,
    onRemove: () => void
  ) => (
    <Row>
      <FieldLabel>
        name
        {txt(f.name, (v) => onPatch({ name: v }), 'snake_case')}
      </FieldLabel>
      <FieldLabel style={{ maxWidth: 130 }}>
        type
        <Select
          value={f.type}
          onChange={(_e: unknown, d: { value: string | number | boolean }) =>
            onPatch({ type: String(d.value) as UccFieldType })
          }
        >
          {FIELD_TYPES.map((t) => (
            <Select.Option key={t} label={t} value={t} />
          ))}
        </Select>
      </FieldLabel>
      <Switch
        selected={!!f.encrypted}
        onClick={() => onPatch({ encrypted: !f.encrypted })}
        appearance="checkbox"
      >
        encrypted
      </Switch>
      <Switch
        selected={!!f.required}
        onClick={() => onPatch({ required: !f.required })}
        appearance="checkbox"
      >
        required
      </Switch>
      <Button appearance="destructive" onClick={onRemove} label="✕" />
    </Row>
  );

  return (
    <>
      <Wrap>
        <Message type="info">
          Review the proposed add-on. Edit anything, then build — the agent will author it
          to match. {draft.grounded ? <Tag $ok>schema-grounded</Tag> : <Tag>not grounded</Tag>}
        </Message>

        {warnings.length > 0 && (
          <Message type="warning">
            {warnings.map((w, i) => (
              <div key={i}>• {w}</div>
            ))}
          </Message>
        )}

        <Card>
          <SectionTitle level={5}>Add-on</SectionTitle>
          <Row>
            <FieldLabel>
              Display name
              {txt(draft.name, (v) => top({ name: v }))}
            </FieldLabel>
            <FieldLabel>
              App ID
              {txt(draft.appId, (v) => top({ appId: v }), 'TA_vendor_product')}
            </FieldLabel>
          </Row>
          <Row>
            <FieldLabel>
              Vendor
              {txt(draft.vendor, (v) => top({ vendor: v }))}
            </FieldLabel>
            <FieldLabel>
              Default index
              {txt(draft.defaultIndex, (v) => top({ defaultIndex: v }), 'main')}
            </FieldLabel>
          </Row>
          <FieldLabel>
            Description
            {txt(draft.description, (v) => top({ description: v }))}
          </FieldLabel>
        </Card>

        <Card>
          <SectionTitle level={5}>Account / authentication</SectionTitle>
          <Row>
            <FieldLabel style={{ maxWidth: 180 }}>
              Auth type
              <Select
                value={draft.account.authType}
                onChange={(_e: unknown, d: { value: string | number | boolean }) =>
                  setAccount({ authType: String(d.value) as UccAuthType })
                }
              >
                {AUTH_TYPES.map((t) => (
                  <Select.Option key={t} label={t} value={t} />
                ))}
              </Select>
            </FieldLabel>
            <Switch
              selected={!!draft.account.multipleAccounts}
              onClick={() => setAccount({ multipleAccounts: !draft.account.multipleAccounts })}
              appearance="checkbox"
            >
              multiple accounts
            </Switch>
          </Row>
          {draft.account.fields.map((f, i) => (
            <div key={i}>
              {renderFieldRow(f, (patch) => setAccountField(i, patch), () => removeAccountField(i))}
            </div>
          ))}
          <div>
            <Button appearance="default" onClick={addAccountField} label="+ credential field" />
          </div>
        </Card>

        <Card>
          <SectionTitle level={5}>Settings</SectionTitle>
          <Row>
            <Switch selected={draft.proxy} onClick={() => top({ proxy: !draft.proxy })} appearance="toggle">
              Proxy support
            </Switch>
            <Switch
              selected={draft.loggingLevel}
              onClick={() => top({ loggingLevel: !draft.loggingLevel })}
              appearance="toggle"
            >
              Logging level
            </Switch>
            <Switch
              selected={!!draft.sslVerify}
              onClick={() => top({ sslVerify: !draft.sslVerify })}
              appearance="toggle"
            >
              SSL verify toggle
            </Switch>
          </Row>
        </Card>

        <Row style={{ justifyContent: 'space-between' }}>
          <SectionTitle level={5}>Inputs ({draft.inputs.length})</SectionTitle>
          <Button appearance="default" onClick={addInput} label="+ input" />
        </Row>
        {draft.inputs.map((inp, i) => (
          <Card key={i}>
            <Row>
              <FieldLabel>
                name
                {txt(inp.name, (v) => setInput(i, { name: v }), 'snake_case')}
              </FieldLabel>
              <FieldLabel style={{ maxWidth: 160 }}>
                collection
                <Select
                  value={inp.collection}
                  onChange={(_e: unknown, d: { value: string | number | boolean }) =>
                    setInput(i, { collection: String(d.value) as UccCollection })
                  }
                >
                  {COLLECTIONS.map((c) => (
                    <Select.Option key={c} label={c} value={c} />
                  ))}
                </Select>
              </FieldLabel>
              <Button appearance="destructive" onClick={() => removeInput(i)} label="remove input" />
            </Row>
            <Row>
              <FieldLabel>
                endpoint
                {txt(inp.endpoint, (v) => setInput(i, { endpoint: v }), 'https://…')}
              </FieldLabel>
              <FieldLabel style={{ maxWidth: 90 }}>
                interval (s)
                {txt(inp.interval, (v) => setInput(i, { interval: Number(v) || undefined }), '300')}
              </FieldLabel>
            </Row>
            <Row>
              <FieldLabel>
                sourcetype
                {txt(inp.sourcetype, (v) => setInput(i, { sourcetype: v }), 'vendor:product:dataset')}
              </FieldLabel>
              <FieldLabel style={{ maxWidth: 140 }}>
                CIM model
                {txt(inp.cim, (v) => setInput(i, { cim: v }), 'Web / Authentication / …')}
              </FieldLabel>
              <Switch
                selected={!!inp.checkpoint}
                onClick={() => setInput(i, { checkpoint: !inp.checkpoint })}
                appearance="checkbox"
              >
                checkpoint
              </Switch>
            </Row>
            {inp.fields.length > 0 && (
              <div style={{ fontSize: '0.75rem', color: '#9b9ea3' }}>parameters</div>
            )}
            {inp.fields.map((f, fi) => (
              <div key={fi}>
                {renderFieldRow(
                  f,
                  (patch) => setInputField(i, fi, patch),
                  () => removeInputField(i, fi)
                )}
              </div>
            ))}
            <div>
              <Button appearance="default" onClick={() => addInputField(i)} label="+ parameter" />
            </div>
          </Card>
        ))}

        {(draft.questions?.length || draft.gaps?.length) && (
          <Card>
            {draft.questions?.length ? (
              <>
                <SectionTitle level={5}>Questions this add-on helps answer</SectionTitle>
                {draft.questions.map((q, i) => (
                  <div key={i} style={{ fontSize: '0.85rem' }}>
                    • {q}
                  </div>
                ))}
              </>
            ) : null}
            {draft.gaps?.length ? (
              <>
                <SectionTitle level={5} style={{ marginTop: 8 }}>
                  Known gaps
                </SectionTitle>
                {draft.gaps.map((g, i) => (
                  <div key={i} style={{ fontSize: '0.85rem', color: '#d6a04a' }}>
                    • {g}
                  </div>
                ))}
              </>
            ) : null}
          </Card>
        )}
      </Wrap>

      <Footer>
        <Button appearance="default" onClick={onCancel} disabled={busy} label="Back" />
        <Button
          appearance="primary"
          onClick={() => onBuild(draft)}
          disabled={busy || draft.inputs.length === 0}
          label={busy ? 'Building…' : 'Build add-on'}
        />
      </Footer>
    </>
  );
}
