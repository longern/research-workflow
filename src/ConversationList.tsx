import DeleteIcon from "@mui/icons-material/Delete";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import {
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Menu,
  MenuItem,
} from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ChatMessage } from "./MessageList";

export interface Conversation {
  id: string;
  title: string;
  create_time: number;
  messages: ChatMessage[];
}

function groupedConversations(conversations: Conversation[]) {
  const groups: Conversation[][] = [];
  const breakpoints = [
    new Date().setHours(0, 0, 0, 0),
    new Date().setHours(0, 0, 0, 0) - 24 * 60 * 60 * 1000,
    new Date().setHours(0, 0, 0, 0) - 7 * 24 * 60 * 60 * 1000,
    new Date().setHours(0, 0, 0, 0) - 30 * 24 * 60 * 60 * 1000,
  ];
  let group: Conversation[] = [];
  let currentGroup = 0;
  for (const conversation of conversations) {
    while (
      currentGroup < breakpoints.length &&
      conversation.create_time < breakpoints[currentGroup]
    ) {
      groups.push(group);
      group = [];
      currentGroup += 1;
    }
    group.push(conversation);
  }
  groups.push(group);

  return groups;
}

function ConversationList({
  conversations,
  selectedConversation,
  onSelect,
  onDelete,
}: {
  conversations: Record<string, Conversation>;
  selectedConversation: string | null;
  onSelect: (conversation: Conversation) => void;
  onDelete: (conversation: Conversation) => void;
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [menuConversation, setMenuConversation] = useState<Conversation | null>(
    null
  );

  const { t } = useTranslation();

  return (
    <>
      <List disablePadding sx={{ overflowY: "auto" }}>
        {groupedConversations(Object.values(conversations)).map(
          (group, index) =>
            group.length ? (
              <>
                <ListSubheader
                  sx={{
                    background: "#f9fbff",
                    color: "text.secondary",
                    lineHeight: "unset",
                    fontWeight: "bold",
                    marginTop: 2,
                    marginBottom: 1,
                  }}
                >
                  {index === 0
                    ? t("Today")
                    : index === 1
                    ? t("Yesterday")
                    : index === 2
                    ? t("In 7 days")
                    : index === 3
                    ? t("In 30 days")
                    : t("Older")}
                </ListSubheader>
                {group.map((conversation) => (
                  <ListItem
                    disablePadding
                    key={conversation.id}
                    secondaryAction={
                      <IconButton
                        onClick={(e) => {
                          setAnchorEl(e.currentTarget);
                          setMenuConversation(conversation);
                        }}
                      >
                        <MoreHorizIcon />
                      </IconButton>
                    }
                  >
                    <ListItemButton
                      selected={conversation.id === selectedConversation}
                      onClick={() => onSelect(conversation)}
                    >
                      {conversation.title}
                    </ListItemButton>
                  </ListItem>
                ))}
              </>
            ) : null
        )}
      </List>
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => {
          setAnchorEl(null);
          setMenuConversation(null);
        }}
      >
        <MenuItem
          onClick={() => {
            setAnchorEl(null);
            setMenuConversation(null);
            onDelete(menuConversation!);
          }}
        >
          <ListItemIcon>
            <DeleteIcon color="error" />
          </ListItemIcon>
          <ListItemText
            sx={{ color: "error.main" }}
            primary={t("Delete")}
          ></ListItemText>
        </MenuItem>
      </Menu>
    </>
  );
}

export default ConversationList;
