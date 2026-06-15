/**
 * Template Gallery Component
 *
 * A modal dialog that displays available templates and allows users
 * to add them to their project.
 */

import { useState, useCallback, useRef } from 'react';
import styled from 'styled-components';
import Modal from '@splunk/react-ui/Modal';
import Button from '@splunk/react-ui/Button';
import Text from '@splunk/react-ui/Text';
import Select from '@splunk/react-ui/Select';
import variables from '@splunk/themes/variables';

import type { Template, TemplateCategory } from '../../types/templates';
import { TEMPLATE_CATEGORIES, DIFFICULTY_INFO } from '../../types/templates';
import { getAllTemplates, searchTemplates } from '../../templates';

interface TemplateGalleryProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTemplate: (template: Template) => void;
}

// Styled Components
const GalleryHeader = styled.div`
  display: flex;
  gap: 16px;
  margin-bottom: 24px;
  align-items: center;
  flex-wrap: wrap;
`;

const SearchInput = styled(Text)`
  flex: 1;
  min-width: 200px;
`;

const FilterSelect = styled(Select)`
  min-width: 150px;
`;

const TemplatesGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  max-height: 400px;
  overflow-y: auto;
  padding-right: 8px;
`;

const TemplateCard = styled.div<{ $isSelected: boolean }>`
  background: ${variables.backgroundColorDialog};
  border: 2px solid ${(props) => (props.$isSelected ? '#65A637' : variables.borderColor)};
  border-radius: 12px;
  padding: 20px;
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;

  &:hover {
    border-color: #65a637;
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }

  ${(props) =>
    props.$isSelected &&
    `
    background: rgba(101, 166, 55, 0.1);
  `}
`;

const CardHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
`;

const CardIcon = styled.span`
  font-size: 1.75rem;
`;

const CardTitle = styled.h3`
  margin: 0;
  font-size: 1.1rem;
  font-weight: 600;
  color: ${variables.contentColorDefault};
`;

const CardDescription = styled.p`
  margin: 0 0 12px 0;
  font-size: 0.875rem;
  color: ${variables.contentColorMuted};
  line-height: 1.5;
`;

const CardMeta = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.75rem;
`;

const DifficultyStars = styled.span`
  color: #ffb800;
`;

const CategoryBadge = styled.span`
  background: rgba(101, 166, 55, 0.15);
  color: #65a637;
  padding: 4px 8px;
  border-radius: 4px;
  font-weight: 500;
`;

const PreviewPanel = styled.div`
  margin-top: 24px;
  padding: 20px;
  background: ${variables.backgroundColorPage};
  border-radius: 8px;
  border: 1px solid ${variables.borderColor};
`;

const PreviewTitle = styled.h4`
  margin: 0 0 12px 0;
  font-size: 1rem;
  color: ${variables.contentColorDefault};
`;

const PreviewSection = styled.div`
  margin-bottom: 16px;

  &:last-child {
    margin-bottom: 0;
  }
`;

const PreviewLabel = styled.div`
  font-weight: 600;
  font-size: 0.875rem;
  color: ${variables.contentColorDefault};
  margin-bottom: 8px;
`;

const PreviewList = styled.ul`
  margin: 0;
  padding-left: 20px;
  font-size: 0.875rem;
  color: ${variables.contentColorMuted};

  li {
    margin-bottom: 4px;
  }
`;

const EmptyState = styled.div`
  text-align: center;
  padding: 48px 24px;
  color: ${variables.contentColorMuted};

  p {
    margin: 8px 0 0 0;
    font-size: 0.875rem;
  }
`;

const ModalActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid ${variables.borderColor};
`;

/**
 * Render difficulty as stars
 */
function renderDifficulty(difficulty: 'beginner' | 'intermediate' | 'advanced'): JSX.Element {
  const info = DIFFICULTY_INFO[difficulty];
  const stars = '⭐'.repeat(info.stars);
  return (
    <span title={info.label}>
      <DifficultyStars>{stars}</DifficultyStars>
      <span style={{ marginLeft: 6, color: '#9b9ea3' }}>{info.label}</span>
    </span>
  );
}

/**
 * Get category label
 */
function getCategoryLabel(categoryId: TemplateCategory): string {
  const cat = TEMPLATE_CATEGORIES.find((c) => c.id === categoryId);
  return cat?.label || categoryId;
}

export function TemplateGallery({ isOpen, onClose, onSelectTemplate }: TemplateGalleryProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<TemplateCategory | 'all'>('all');
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const modalReturnRef = useRef<HTMLElement>(null);

  // Filter templates
  const filteredTemplates = useCallback(() => {
    let templates = searchQuery ? searchTemplates(searchQuery) : getAllTemplates();

    if (categoryFilter !== 'all') {
      templates = templates.filter((t) => t.metadata.category === categoryFilter);
    }

    return templates;
  }, [searchQuery, categoryFilter])();

  const handleSearchChange = useCallback((_e: unknown, { value }: { value: string }) => {
    setSearchQuery(value);
    setSelectedTemplate(null);
  }, []);

  const handleCategoryChange = useCallback(
    (_e: unknown, { value }: { value: string | number | boolean }) => {
      setCategoryFilter(String(value) as TemplateCategory | 'all');
      setSelectedTemplate(null);
    },
    []
  );

  const handleCardClick = useCallback((template: Template) => {
    setSelectedTemplate(template);
  }, []);

  const handleApply = useCallback(() => {
    if (selectedTemplate) {
      onSelectTemplate(selectedTemplate);
      onClose();
      // Reset state
      setSearchQuery('');
      setCategoryFilter('all');
      setSelectedTemplate(null);
    }
  }, [selectedTemplate, onSelectTemplate, onClose]);

  const handleClose = useCallback(() => {
    onClose();
    setSearchQuery('');
    setCategoryFilter('all');
    setSelectedTemplate(null);
  }, [onClose]);

  return (
    <Modal
      open={isOpen}
      onRequestClose={handleClose}
      returnFocus={modalReturnRef as React.MutableRefObject<HTMLElement>}
      style={{ width: '800px', maxWidth: '90vw' }}
    >
      <Modal.Header title="🧰 Template Gallery" />
      <Modal.Body>
        <GalleryHeader>
          <SearchInput
            value={searchQuery}
            onChange={handleSearchChange}
            placeholder="Search templates..."
            canClear
          />
          <FilterSelect value={categoryFilter} onChange={handleCategoryChange}>
            <Select.Option label="All Categories" value="all" />
            {TEMPLATE_CATEGORIES.map((cat) => (
              <Select.Option key={cat.id} label={`${cat.icon} ${cat.label}`} value={cat.id} />
            ))}
          </FilterSelect>
        </GalleryHeader>

        {filteredTemplates.length === 0 ? (
          <EmptyState>
            <h3>No templates found</h3>
            <p>Try adjusting your search or filter criteria</p>
          </EmptyState>
        ) : (
          <TemplatesGrid>
            {filteredTemplates.map((template) => (
              <TemplateCard
                key={template.metadata.id}
                $isSelected={selectedTemplate?.metadata.id === template.metadata.id}
                onClick={() => handleCardClick(template)}
              >
                <CardHeader>
                  <CardIcon>{template.metadata.icon}</CardIcon>
                  <CardTitle>{template.metadata.name}</CardTitle>
                </CardHeader>
                <CardDescription>{template.metadata.description}</CardDescription>
                <CardMeta>
                  {renderDifficulty(template.metadata.difficulty)}
                  <CategoryBadge>{getCategoryLabel(template.metadata.category)}</CategoryBadge>
                </CardMeta>
              </TemplateCard>
            ))}
          </TemplatesGrid>
        )}

        {selectedTemplate && (
          <PreviewPanel>
            <PreviewTitle>What This Template Adds</PreviewTitle>
            <PreviewSection>
              <PreviewList>
                {selectedTemplate.addsSummary.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </PreviewList>
            </PreviewSection>

            {selectedTemplate.prerequisites && selectedTemplate.prerequisites.length > 0 && (
              <PreviewSection>
                <PreviewLabel>Prerequisites</PreviewLabel>
                <PreviewList>
                  {selectedTemplate.prerequisites.map((item, idx) => (
                    <li key={idx}>{item}</li>
                  ))}
                </PreviewList>
              </PreviewSection>
            )}
          </PreviewPanel>
        )}

        <ModalActions>
          <Button label="Cancel" onClick={handleClose} />
          <Button
            label="Use Template"
            appearance="primary"
            onClick={handleApply}
            disabled={!selectedTemplate}
          />
        </ModalActions>
      </Modal.Body>
    </Modal>
  );
}
