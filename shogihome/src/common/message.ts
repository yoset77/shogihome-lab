export type ListItem = {
  text: string;
  children?: string[];
};

export type List = {
  type: "list";
  items: ListItem[];
};

export type Link = {
  type: "link";
  text: string;
  url: string;
};

export type Attachment = List | Link;

export type Message = {
  text: string;
  attachments?: Attachment[];
};
